// An observer's observations of its targets, in the order they were made (resize_observers.rs,
// intersection_observers.rs): each target's one, found by the target and by the number it was made with, added at the
// end and taken out wherever it is — each in O(log n), however many targets an observer has (a lazy-loading observer
// of a long list unobserves each one as it comes into view), and visited in order.

use std::collections::{BTreeMap, HashMap};

use crate::dom::NodeId;

pub(crate) struct ObservationList<T> {
    by_serial: BTreeMap<u64, (NodeId, T)>,
    serial_of: HashMap<NodeId, u64>,
    next: u64,
}

impl<T> Default for ObservationList<T> {
    fn default() -> Self {
        ObservationList { by_serial: BTreeMap::new(), serial_of: HashMap::new(), next: 0 }
    }
}

impl<T> ObservationList<T> {
    pub(crate) fn is_empty(&self) -> bool {
        self.by_serial.is_empty()
    }
    pub(crate) fn contains(&self, target: NodeId) -> bool {
        self.serial_of.contains_key(&target)
    }
    // `target`'s observation made anew, at the end — the one it had, if any, taken out — and its serial.
    pub(crate) fn push(&mut self, target: NodeId, observation: T) -> u64 {
        self.remove(target);
        let serial = self.next;
        self.next += 1;
        self.by_serial.insert(serial, (target, observation));
        self.serial_of.insert(target, serial);
        serial
    }
    pub(crate) fn remove(&mut self, target: NodeId) -> Option<T> {
        let serial = self.serial_of.remove(&target)?;
        self.by_serial.remove(&serial).map(|(_, o)| o)
    }
    pub(crate) fn get_mut(&mut self, target: NodeId) -> Option<&mut T> {
        let serial = *self.serial_of.get(&target)?;
        self.by_serial.get_mut(&serial).map(|(_, o)| o)
    }
    // The observation made with `serial`, while it is the target's still.
    pub(crate) fn by_serial_mut(&mut self, serial: u64) -> Option<&mut T> {
        self.by_serial.get_mut(&serial).map(|(_, o)| o)
    }
    pub(crate) fn iter(&self) -> impl Iterator<Item = (u64, NodeId, &T)> {
        self.by_serial.iter().map(|(&s, (t, o))| (s, *t, o))
    }
    pub(crate) fn iter_mut(&mut self) -> impl Iterator<Item = (u64, NodeId, &mut T)> {
        self.by_serial.iter_mut().map(|(&s, (t, o))| (s, *t, o))
    }
}
