// What a Rust walk's pass keeps of the last one (step 3.9): the layout of every subtree the walk built exactly as it did
// last time is put back instead of laid out again. The walk still builds every record — it reads the style engine's
// values, and a subtree is known to be unchanged only once it is built — but the layout, which is most of a pass, is
// the measure cache's to answer (`layout::MeasureCache`, the one a JS walk's kept chunks feed): each element's subtree
// is a CHUNK, and keeps its id from pass to pass for as long as it is the same.
//
// "The same" is decided against the last pass's records, bit for bit, with every position a record or a run names made
// relative to the subtree: its parent, its run and grid start, the containing block it names inside the subtree (one
// outside it is the same wherever it is — a measure never reads it), and a run's record or inline entry. The subtree's
// ROOT is not held to it — the measure cache keys on the root's record itself (`Input::at_rest`) — and a child that
// is the same is skipped whole, so a record is compared once however deep the subtrees nest: a subtree is the same
// when its own records and streams are, and each of its children is, where it was.
//
// A subtree's streams are where the walk put them: everything it emits comes after its root goes in and before the
// next record that is not its own (`Built::marks`). An ancestor's that lands in between — the text an inline-block is
// followed by — is held against its last pass along with the subtree's, which can only keep less.
use std::collections::HashMap;

use crate::layout::{ChunkRoot, InlineBox, Input, MeasureCache, Run, RunText};
use crate::walk::MathTable;
use crate::layout::{DISPLAY_GRID, DISPLAY_TABLE, RUN_ATOMIC, RUN_BR, RUN_CLOSE, RUN_FLOAT, RUN_OOF, RUN_OPEN, RUN_WBR};

// A chunk not placed for this many passes is forgotten, its measures with it (as `dom.rs`'s JS chunks are).
const IDLE_PASSES: u64 = 16;

#[derive(Default)]
pub(crate) struct WalkReuse {
    last: Option<Last>,
    // What the faces were resolved as when the last pass was built: a pass under another generation keeps nothing.
    generation: String,
    pass: u64,
    next_id: u32,
    // The chunk ids in play, each by the pass that last placed it.
    used: HashMap<u32, u64>,
    pub(crate) measure: MeasureCache,
    // The realm's programs (`walk::MathTable`), whose offsets the records name — the same program at the same offset
    // from pass to pass, which is what makes an offset compared as a number compared as a program. Lent to the walk
    // (`maths_for_pass`) and to the layout, which takes it and puts it back.
    pub(crate) maths: MathTable,
}

// What `WalkReuse::chunks` makes of a pass.
#[derive(Default)]
pub(crate) struct Pass {
    pub(crate) roots: HashMap<usize, ChunkRoot>,
    pub(crate) ends: Vec<usize>,
    pub(crate) ids: Vec<u32>,
    // …and the records built as the last pass built them, as flat `[start, end)` pairs — which the JS side writes back
    // only where the box the layout gave them moved (`nlWriteBoxes`'s kept ranges).
    pub(crate) unchanged: Vec<f64>,
}

// The last pass as the walk built it — before the layout wrote into its records.
struct Last {
    inputs: Vec<Input>,
    runs: Vec<Run>,
    run_texts: Vec<RunText>,
    grids: Vec<f64>,
    inlines: Vec<InlineBox>,
    marks: Vec<[usize; 3]>,
    ends: Vec<usize>,
    // Each element's record, by nid, and the chunk each record was the root of (0: none).
    by_nid: HashMap<u64, usize>,
    ids: Vec<u32>,
}

// A pass's streams, as the walk built them.
pub(crate) struct Streams<'a> {
    pub(crate) inputs: &'a [Input],
    pub(crate) runs: &'a [Run],
    pub(crate) run_texts: &'a [RunText],
    pub(crate) grids: &'a [f64],
    pub(crate) inlines: &'a [InlineBox],
    pub(crate) marks: &'a [[usize; 3]],
}

// How many values the math table grows to before it is started afresh — every offset moved, so nothing of the last pass
// holds (the JS walk's table is capped alike).
const MATH_TABLE_CAP: usize = 1 << 20;

impl WalkReuse {
    // The realm's math table for the walk to build a pass with: started afresh past its cap, the last pass forgotten
    // with it — asked ONCE, at the start of the pass. (Asked again after the walk had pushed the table past the cap, it
    // handed the layout an empty table under records naming offsets into the full one, and every `min()`-sized box of
    // that pass came out 0.)
    pub(crate) fn maths_for_pass(&mut self) -> &mut MathTable {
        if self.maths.values.len() > MATH_TABLE_CAP {
            self.maths = MathTable::default();
            self.last = None;
        }
        &mut self.maths
    }

    // The chunks of this pass, by root record, for the layout to key its measures on — what `keep` needs of it — and
    // the records built as the last pass built them, as `[start, end)` ranges: every record under a subtree root but
    // the root, where the subtree is the same (`Pass::unchanged`).
    pub(crate) fn chunks(&mut self, s: &Streams, generation: &str) -> Pass {
        self.pass += 1;
        if generation != self.generation {
            self.generation = generation.to_owned();
            self.last = None;
        }
        let Some(ends) = subtree_ends(s.inputs) else { return Pass::default() };
        let n = s.inputs.len();
        let mut same = vec![false; n];
        let mut ids = vec![0u32; n];
        let mut roots = HashMap::new();
        // (…children first: a child's record comes after its parent's)
        for i in (0..n).rev() {
            let nid = s.inputs[i].nid;
            if nid < 0.0 {
                continue;
            }
            let was = self.last.as_ref().and_then(|l| l.by_nid.get(&nid.to_bits()).copied());
            same[i] = match (&self.last, was) {
                (Some(last), Some(j)) => same_subtree(s, &ends, &same, last, i, j),
                _ => false,
            };
            let kept = match (&self.last, was) {
                (Some(last), Some(j)) if same[i] && last.ids[j] != 0 => Some(last.ids[j]),
                _ => None,
            };
            let id = kept.unwrap_or_else(|| {
                self.next_id = self.next_id.wrapping_add(1).max(1);
                self.next_id
            });
            ids[i] = id;
            self.used.insert(id, self.pass);
            let [runs_at, grids_at, inl_at] = s.marks[i];
            roots.insert(i, ChunkRoot {
                id,
                n: ends[i] - i,
                runs_at,
                grids_at,
                inl_at,
                root_runs: s.inputs[i].run_count > 0,
                root_grid: has_grid(&s.inputs[i]),
                fresh: kept.is_none(),
            });
        }
        if self.pass % IDLE_PASSES == 0 {
            let pass = self.pass;
            let measure = &mut self.measure;
            self.used.retain(|&id, &mut at| {
                let live = pass - at < IDLE_PASSES;
                if !live {
                    measure.forget(id);
                }
                live
            });
        }
        // (…the outermost same subtree's, each: one inside it is covered already)
        let mut unchanged = Vec::new();
        let mut covered = 0;
        for i in 0..n {
            if same[i] && i + 1 >= covered && ends[i] > i + 1 {
                unchanged.extend([(i + 1) as f64, ends[i] as f64]);
                covered = ends[i];
            }
        }
        Pass { roots, ends, ids, unchanged }
    }

    // This pass, kept for the next to be held against.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn keep(
        &mut self,
        inputs: Vec<Input>,
        runs: Vec<Run>,
        run_texts: Vec<RunText>,
        grids: Vec<f64>,
        inlines: Vec<InlineBox>,
        marks: Vec<[usize; 3]>,
        ends: Vec<usize>,
        ids: Vec<u32>,
    ) {
        if ends.len() != inputs.len() {
            self.last = None;
            return;
        }
        let by_nid = inputs.iter().enumerate().filter(|(_, r)| r.nid >= 0.0).map(|(i, r)| (r.nid.to_bits(), i)).collect();
        self.last = Some(Last { inputs, runs, run_texts, grids, inlines, marks, ends, by_nid, ids });
    }
}

// Where each record's subtree ends — the records of a subtree are its root and those after it up to the next that is
// not its own — or None where a record's parent is not an open ancestor (the records are not in tree order).
fn subtree_ends(inputs: &[Input]) -> Option<Vec<usize>> {
    let mut ends = vec![inputs.len(); inputs.len()];
    let mut open: Vec<usize> = Vec::new();
    for (j, r) in inputs.iter().enumerate() {
        if r.parent < 0 {
            if j != 0 {
                return None;
            }
        } else {
            let p = r.parent as usize;
            while open.last().is_some_and(|&top| top != p) {
                ends[open.pop()?] = j;
            }
            open.last()?;
        }
        open.push(j);
    }
    Some(ends)
}

// Where a subtree's streams end: where the next record not its own went in, or where the streams stand.
fn stream_end(marks: &[[usize; 3]], ends: &[usize], i: usize, runs: usize, grids: usize, inls: usize) -> [usize; 3] {
    marks.get(ends[i]).copied().unwrap_or([runs, grids, inls])
}

// Whether the subtree at record `i` is the one at record `j` of the last pass: the same records after its root, each
// child subtree the same where it was, and the same runs, grid values and inline entries — every position made the
// subtree's own.
fn same_subtree(s: &Streams, ends: &[usize], same: &[bool], last: &Last, i: usize, j: usize) -> bool {
    let (end, end_j) = (ends[i], last.ends[j]);
    if end - i != end_j - j {
        return false;
    }
    let base = Base { rec: i, end, streams: s.marks[i] };
    let base_j = Base { rec: j, end: end_j, streams: last.marks[j] };
    let s_end = stream_end(s.marks, ends, i, s.runs.len(), s.grids.len(), s.inlines.len());
    let l_end = stream_end(&last.marks, &last.ends, j, last.runs.len(), last.grids.len(), last.inlines.len());
    if (0..3).any(|k| s_end[k] - base.streams[k] != l_end[k] - base_j.streams[k]) {
        return false;
    }
    // The streams from `at` to `to` (this pass's positions), held against the last pass's at the same offsets.
    let streams_same = |at: [usize; 3], to: [usize; 3]| {
        let shift = |k: usize, p: usize| p - base.streams[k] + base_j.streams[k];
        (at[0]..to[0]).all(|r| {
            let q = shift(0, r);
            run_rel(&s.runs[r], &base).same(&run_rel(&last.runs[q], &base_j)) && s.run_texts[r] == last.run_texts[q]
        }) && (at[1]..to[1]).all(|g| s.grids[g].to_bits() == last.grids[shift(1, g)].to_bits())
            && (at[2]..to[2]).all(|l| s.inlines[l].same(&last.inlines[shift(2, l)]))
    };
    let mut cursor = s.marks[i];
    let mut k = i + 1;
    while k < end {
        if !streams_same(cursor, s.marks[k]) {
            return false;
        }
        let kj = k - i + j;
        if !input_rel(&s.inputs[k], &base).same(&input_rel(&last.inputs[kj], &base_j)) {
            return false;
        }
        if s.inputs[k].nid >= 0.0 {
            // A child's subtree: the same where it was, and passed over whole.
            if !same[k] || last.by_nid.get(&s.inputs[k].nid.to_bits()) != Some(&kj) {
                return false;
            }
            cursor = stream_end(s.marks, ends, k, s.runs.len(), s.grids.len(), s.inlines.len());
            k = ends[k];
        } else {
            cursor = s.marks[k];
            k += 1;
        }
    }
    streams_same(cursor, s_end)
}

// Where a subtree starts in each stream, and where its records end.
struct Base {
    rec: usize,
    end: usize,
    streams: [usize; 3],
}

// A record with every position it names made the subtree's own.
fn input_rel(x: &Input, b: &Base) -> Input {
    let mut x = *x;
    x.parent -= b.rec as i32;
    if x.run_count > 0 {
        x.run_start -= b.streams[0] as i32;
    }
    if has_grid(&x) {
        x.grid_start -= b.streams[1] as i32;
    }
    if x.cb_index >= 0 {
        let cb = x.cb_index as usize;
        x.cb_index = if (b.rec..b.end).contains(&cb) { (cb - b.rec) as i32 } else { i32::MIN };
    }
    x
}

// Whether a record names a place in the grid stream: a grid's or a table's. (Every other record carries a `grid_start`
// of 0 as it was made, which is no position — rebased as one, a table put in anywhere before a subtree moved its key.)
fn has_grid(x: &Input) -> bool {
    matches!(x.display, DISPLAY_GRID | DISPLAY_TABLE) && x.grid_start >= 0
}

// A run with the record or inline entry it names made the subtree's own (as `dom.rs` `emit_chunk` relocates them).
fn run_rel(r: &Run, b: &Base) -> Run {
    let mut r = *r;
    match r.kind {
        RUN_OOF | RUN_FLOAT | RUN_ATOMIC if r.font >= 0 => r.font -= b.rec as i32,
        RUN_OPEN | RUN_CLOSE | RUN_WBR => r.font -= b.streams[2] as i32,
        RUN_BR if r.font >= 0 => r.font -= b.streams[2] as i32,
        _ => {}
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    // A table the walk grew past the cap is the one the layout reads that pass — started afresh only when the NEXT pass
    // asks for it, with the last pass forgotten then.
    #[test]
    fn a_table_grown_past_the_cap_holds_until_the_next_pass() {
        let mut reuse = WalkReuse::default();
        reuse.maths_for_pass().values.resize(MATH_TABLE_CAP + 10, 1.0);
        assert_eq!(std::mem::take(&mut reuse.maths).values.len(), MATH_TABLE_CAP + 10);
        reuse.maths.values.resize(MATH_TABLE_CAP + 10, 1.0);
        assert!(reuse.maths_for_pass().values.is_empty());
    }
}
