// XPath 1.0 (W3C REC) over the arena — `document.evaluate` and every Capybara find. A port of the xpathway engine's
// algorithms (lexer, recursive-descent parser, evaluator, axes, core function library, HTML name rules), reading the
// arena instead of a JS DOM adapter. Strings are UTF-16 code units, as a DOMString is (substring / string-length /
// translate count units, as the browsers do).
//
// The DOM's XPath rules for an HTML document (HTML § "Interactions with XPath and XSLT"): an unprefixed element name
// test names the HTML namespace and is ASCII-lowercased before it is compared (so it matches no SVG and no
// no-namespace element), and an unprefixed attribute test of an HTML element is ASCII-lowercased likewise; in an XML
// document, and for a foreign element's attributes, the test is XPath's own — no namespace, case-sensitive.
// (The spec's text sets only the default element namespace, and says nothing of case; the lowercasing is the engines'.
// They split on an HTML-namespace element made with an UPPERCASE local name — `createElementNS(html, 'DIV')`: Chrome
// matches it by `//div`, Firefox by nothing. This is Firefox's model, which `querySelectorAll('DIV')` shares.)
//
// Namespace prefixes are resolved by the caller before evaluation (the page's resolver is JS, and is asked once per
// prefix per evaluation, as Blink's parser asks it) and handed in.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::dom::{NodeId, NodeKind, RealmArena};
use crate::selector::HTML_NS;

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";

type Str = Vec<u16>;

fn utf16(s: &str) -> Str {
    s.encode_utf16().collect()
}

// ── errors ────────────────────────────────────────────────────────────────────────────────────────────────────────

// An expression that does not parse (INVALID_EXPRESSION_ERR: a SyntaxError), a value of the wrong type
// (TYPE_ERR: a TypeError), or a prefix the resolver did not bind (NAMESPACE_ERR).
#[derive(Debug)]
pub(crate) enum XError {
    Syntax(String),
    Type(String),
    Namespace(String),
}

fn syntax<T>(msg: impl Into<String>) -> Result<T, XError> {
    Err(XError::Syntax(msg.into()))
}
fn type_err<T>(msg: impl Into<String>) -> Result<T, XError> {
    Err(XError::Type(msg.into()))
}

// ── lexer (REC §3.7) ─────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    LParen,
    RParen,
    LBracket,
    RBracket,
    At,
    Comma,
    DoubleColon,
    Slash,
    DoubleSlash,
    Dot,
    DotDot,
    Pipe,
    Plus,
    Minus,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Multiply,
    And,
    Or,
    Mod,
    Div,
    AxisName(String),
    NodeType(String),
    FuncName(Option<String>, String),
    NameTest(Option<String>, String),
    Number(f64),
    Literal(Str),
    VarRef(String),
    Eof,
}

// After one of these, a `*` or a bare name is a NAME (a name test, an axis, a function, a node type), not an operator
// — the complement of the REC's rule 1: `@`, `::`, `(`, `[`, `,` and the Operators.
fn forces_name(t: &Tok) -> bool {
    matches!(
        t,
        Tok::At
            | Tok::DoubleColon
            | Tok::LParen
            | Tok::LBracket
            | Tok::Comma
            | Tok::Slash
            | Tok::DoubleSlash
            | Tok::Pipe
            | Tok::Plus
            | Tok::Minus
            | Tok::Eq
            | Tok::Ne
            | Tok::Lt
            | Tok::Le
            | Tok::Gt
            | Tok::Ge
            | Tok::Multiply
            | Tok::And
            | Tok::Or
            | Tok::Mod
            | Tok::Div
    )
}

// XML's NameStartChar and NameChar (XML 1.0 5th ed. [4] / [4a]) without the ':' — an NCName's. A typographic quote
// is no name character, so `’xyz’` is no literal and no name either.
fn is_name_start(c: char) -> bool {
    matches!(c as u32,
        0x41..=0x5A | 0x61..=0x7A | 0x5F | 0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x2FF | 0x370..=0x37D | 0x37F..=0x1FFF
        | 0x200C..=0x200D | 0x2070..=0x218F | 0x2C00..=0x2FEF | 0x3001..=0xD7FF | 0xF900..=0xFDCF | 0xFDF0..=0xFFFD
        | 0x10000..=0xEFFFF)
}
fn is_name_char(c: char) -> bool {
    is_name_start(c)
        || c.is_ascii_digit()
        || matches!(c as u32, 0x2D | 0x2E | 0xB7 | 0x300..=0x36F | 0x203F..=0x2040)
}
fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n')
}

// `expr` as the DOMString it is: UTF-16 units. A name holds no lone surrogate, but a literal may, and keeps it — each
// char decoded here is one unit or a pair, and a literal is cut from the units (`unit_at`), not re-encoded. A lone
// surrogate decodes to NUL, which no token rule takes, so outside a literal it is the syntax error it is.
fn tokenize(expr: &[u16]) -> Result<Vec<Tok>, XError> {
    let mut s: Vec<char> = Vec::with_capacity(expr.len());
    let mut unit_at: Vec<usize> = Vec::with_capacity(expr.len() + 1);
    let mut u = 0;
    for c in char::decode_utf16(expr.iter().copied()) {
        unit_at.push(u);
        let (c, units) = match c {
            Ok(c) => (c, c.len_utf16()),
            Err(_) => ('\0', 1),
        };
        u += units;
        s.push(c);
    }
    unit_at.push(u);
    let n = s.len();
    let mut toks: Vec<Tok> = Vec::new();
    let mut i = 0;
    let at = |i: usize| s.get(i).copied().unwrap_or('\0');
    let skip_ws = |mut j: usize| {
        while j < n && is_ws(s[j]) {
            j += 1;
        }
        j
    };
    let nc_end = |start: usize| {
        let mut j = start + 1;
        while j < n && is_name_char(s[j]) {
            j += 1;
        }
        j
    };
    while i < n {
        let c = s[i];
        if is_ws(c) {
            i += 1;
            continue;
        }
        let operator_position = toks.last().is_some_and(|t| !forces_name(t));
        let simple = match c {
            '/' if at(i + 1) == '/' => Some((Tok::DoubleSlash, 2)),
            '/' => Some((Tok::Slash, 1)),
            '!' if at(i + 1) == '=' => Some((Tok::Ne, 2)),
            '!' => return syntax(format!("unexpected '!' at {i}")),
            '<' if at(i + 1) == '=' => Some((Tok::Le, 2)),
            '<' => Some((Tok::Lt, 1)),
            '>' if at(i + 1) == '=' => Some((Tok::Ge, 2)),
            '>' => Some((Tok::Gt, 1)),
            '=' => Some((Tok::Eq, 1)),
            '|' => Some((Tok::Pipe, 1)),
            '+' => Some((Tok::Plus, 1)),
            '-' => Some((Tok::Minus, 1)),
            '(' => Some((Tok::LParen, 1)),
            ')' => Some((Tok::RParen, 1)),
            '[' => Some((Tok::LBracket, 1)),
            ']' => Some((Tok::RBracket, 1)),
            ',' => Some((Tok::Comma, 1)),
            '@' => Some((Tok::At, 1)),
            ':' if at(i + 1) == ':' => Some((Tok::DoubleColon, 2)),
            _ => None,
        };
        if let Some((t, len)) = simple {
            toks.push(t);
            i += len;
            continue;
        }
        if c == '"' || c == '\'' {
            let start = i + 1;
            let mut j = start;
            while j < n && s[j] != c {
                j += 1;
            }
            if j >= n {
                return syntax(format!("unterminated string literal at {i}"));
            }
            toks.push(Tok::Literal(expr[unit_at[start]..unit_at[j]].to_vec()));
            i = j + 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && at(i + 1).is_ascii_digit()) {
            let start = i;
            while i < n && s[i].is_ascii_digit() {
                i += 1;
            }
            // (…a decimal point, but not the first `.` of a `..`)
            if at(i) == '.' && at(i + 1) != '.' {
                i += 1;
                while i < n && s[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let text: String = s[start..i].iter().collect();
            toks.push(Tok::Number(text.parse::<f64>().unwrap_or(f64::NAN)));
            continue;
        }
        if c == '.' {
            if at(i + 1) == '.' {
                toks.push(Tok::DotDot);
                i += 2;
            } else {
                toks.push(Tok::Dot);
                i += 1;
            }
            continue;
        }
        if c == '$' {
            if !is_name_start(at(i + 1)) {
                return syntax(format!("expected a name after '$' at {i}"));
            }
            let mut j = nc_end(i + 1);
            if at(j) == ':' && at(j + 1) != ':' && is_name_start(at(j + 1)) {
                j = nc_end(j + 1);
            }
            toks.push(Tok::VarRef(s[i + 1..j].iter().collect()));
            i = j;
            continue;
        }
        if c == '*' {
            toks.push(if operator_position { Tok::Multiply } else { Tok::NameTest(None, "*".into()) });
            i += 1;
            continue;
        }
        if is_name_start(c) {
            let j = nc_end(i);
            let first: String = s[i..j].iter().collect();
            let (prefix, local, end) = if at(j) == ':' && at(j + 1) != ':' {
                if at(j + 1) == '*' {
                    (Some(first), "*".to_string(), j + 2)
                } else if is_name_start(at(j + 1)) {
                    let k = nc_end(j + 1);
                    (Some(first), s[j + 1..k].iter().collect(), k)
                } else {
                    return syntax(format!("expected a name after ':' at {j}"));
                }
            } else {
                (None, first, j)
            };
            i = end;
            let after = skip_ws(i);
            let paren = at(after) == '(';
            let axis = at(after) == ':' && at(after + 1) == ':';
            // Rule 1 first: in operator position a bare and / or / mod / div is an OperatorName even before a `(`
            // (`(a = 'x') or (b = 'y')`, which Capybara's field finders emit constantly).
            if prefix.is_none() && operator_position {
                let op = match local.as_str() {
                    "and" => Some(Tok::And),
                    "or" => Some(Tok::Or),
                    "mod" => Some(Tok::Mod),
                    "div" => Some(Tok::Div),
                    _ => None,
                };
                if let Some(op) = op {
                    toks.push(op);
                    continue;
                }
            }
            if axis && prefix.is_none() && local != "*" {
                toks.push(Tok::AxisName(local));
            } else if paren && local != "*" {
                if prefix.is_none() && matches!(local.as_str(), "node" | "text" | "comment" | "processing-instruction") {
                    toks.push(Tok::NodeType(local));
                } else {
                    toks.push(Tok::FuncName(prefix, local));
                }
            } else {
                toks.push(Tok::NameTest(prefix, local));
            }
            continue;
        }
        return syntax(format!("unexpected character '{c}' at {i}"));
    }
    toks.push(Tok::Eof);
    Ok(toks)
}

// ── AST + parser (REC §3, productions [1]–[27]) ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Axis {
    Ancestor,
    AncestorOrSelf,
    Attribute,
    Child,
    Descendant,
    DescendantOrSelf,
    Following,
    FollowingSibling,
    Namespace,
    Parent,
    Preceding,
    PrecedingSibling,
    SelfAxis,
}

impl Axis {
    fn named(name: &str) -> Option<Axis> {
        Some(match name {
            "ancestor" => Axis::Ancestor,
            "ancestor-or-self" => Axis::AncestorOrSelf,
            "attribute" => Axis::Attribute,
            "child" => Axis::Child,
            "descendant" => Axis::Descendant,
            "descendant-or-self" => Axis::DescendantOrSelf,
            "following" => Axis::Following,
            "following-sibling" => Axis::FollowingSibling,
            "namespace" => Axis::Namespace,
            "parent" => Axis::Parent,
            "preceding" => Axis::Preceding,
            "preceding-sibling" => Axis::PrecedingSibling,
            "self" => Axis::SelfAxis,
            _ => return None,
        })
    }
    // Two distinct context nodes never share a node on these axes, so a step over many needs no de-duplication.
    fn disjoint(self) -> bool {
        matches!(self, Axis::SelfAxis | Axis::Child | Axis::Attribute | Axis::Namespace)
    }
}

#[derive(Clone, Debug)]
enum NodeTest {
    // (…`lower` the local name ASCII-lowercased, which an HTML document's tests compare)
    Name { prefix: Option<String>, local: String, lower: String },
    Node,
    Text,
    Comment,
    Pi(Option<Str>),
}

#[derive(Clone, Debug)]
struct Step {
    axis: Axis,
    test: NodeTest,
    preds: Vec<Expr>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Union,
}

#[derive(Clone, Debug)]
enum Root {
    Context,
    Document,
    Expr(Box<Expr>),
}

#[derive(Clone, Debug)]
enum Expr {
    Path(Root, Vec<Step>),
    Filter(Box<Expr>, Vec<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
    Neg(Box<Expr>),
    Func(Option<String>, String, Vec<Expr>),
    Literal(Str),
    Number(f64),
}

fn type_step(axis: Axis, test: NodeTest) -> Step {
    Step { axis, test, preds: Vec::new() }
}

struct ParserState {
    toks: Vec<Tok>,
    pos: usize,
}

impl ParserState {
    fn peek(&self) -> &Tok {
        &self.toks[self.pos]
    }
    fn next(&mut self) -> Tok {
        let t = self.toks[self.pos].clone();
        if self.pos + 1 < self.toks.len() {
            self.pos += 1;
        }
        t
    }
    fn expect(&mut self, t: Tok) -> Result<(), XError> {
        if *self.peek() != t {
            return syntax(format!("expected {t:?} but found {:?}", self.peek()));
        }
        self.next();
        Ok(())
    }

    fn expr(&mut self) -> Result<Expr, XError> {
        self.binary(0)
    }

    // The precedence levels, loosest first: or, and, equality, relational, additive, multiplicative.
    fn binary(&mut self, level: usize) -> Result<Expr, XError> {
        if level == 6 {
            return self.unary();
        }
        let mut left = self.binary(level + 1)?;
        loop {
            let op = match (level, self.peek()) {
                (0, Tok::Or) => Op::Or,
                (1, Tok::And) => Op::And,
                (2, Tok::Eq) => Op::Eq,
                (2, Tok::Ne) => Op::Ne,
                (3, Tok::Lt) => Op::Lt,
                (3, Tok::Le) => Op::Le,
                (3, Tok::Gt) => Op::Gt,
                (3, Tok::Ge) => Op::Ge,
                (4, Tok::Plus) => Op::Add,
                (4, Tok::Minus) => Op::Sub,
                (5, Tok::Multiply) => Op::Mul,
                (5, Tok::Div) => Op::Div,
                (5, Tok::Mod) => Op::Mod,
                _ => return Ok(left),
            };
            self.next();
            let right = self.binary(level + 1)?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
    }

    fn unary(&mut self) -> Result<Expr, XError> {
        if *self.peek() == Tok::Minus {
            self.next();
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        let mut left = self.path_expr()?;
        while *self.peek() == Tok::Pipe {
            self.next();
            let right = self.path_expr()?;
            left = Expr::Binary(Op::Union, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn path_expr(&mut self) -> Result<Expr, XError> {
        if matches!(self.peek(), Tok::LParen | Tok::Literal(_) | Tok::Number(_) | Tok::FuncName(..) | Tok::VarRef(_)) {
            let primary = self.filter_expr()?;
            if matches!(self.peek(), Tok::Slash | Tok::DoubleSlash) {
                let mut steps = Vec::new();
                if self.next() == Tok::DoubleSlash {
                    steps.push(type_step(Axis::DescendantOrSelf, NodeTest::Node));
                }
                self.relative_steps(&mut steps)?;
                return Ok(Expr::Path(Root::Expr(Box::new(primary)), steps));
            }
            return Ok(primary);
        }
        match self.peek() {
            Tok::Slash => {
                self.next();
                let mut steps = Vec::new();
                if matches!(self.peek(), Tok::At | Tok::AxisName(_) | Tok::NameTest(..) | Tok::NodeType(_) | Tok::Dot | Tok::DotDot) {
                    self.relative_steps(&mut steps)?;
                }
                Ok(Expr::Path(Root::Document, steps))
            }
            Tok::DoubleSlash => {
                self.next();
                let mut steps = vec![type_step(Axis::DescendantOrSelf, NodeTest::Node)];
                self.relative_steps(&mut steps)?;
                Ok(Expr::Path(Root::Document, steps))
            }
            _ => {
                let mut steps = Vec::new();
                self.relative_steps(&mut steps)?;
                Ok(Expr::Path(Root::Context, steps))
            }
        }
    }

    fn relative_steps(&mut self, steps: &mut Vec<Step>) -> Result<(), XError> {
        steps.push(self.step()?);
        loop {
            match self.peek() {
                Tok::Slash => {
                    self.next();
                    steps.push(self.step()?);
                }
                Tok::DoubleSlash => {
                    self.next();
                    steps.push(type_step(Axis::DescendantOrSelf, NodeTest::Node));
                    steps.push(self.step()?);
                }
                _ => return Ok(()),
            }
        }
    }

    fn step(&mut self) -> Result<Step, XError> {
        match self.peek() {
            Tok::Dot => {
                self.next();
                return Ok(type_step(Axis::SelfAxis, NodeTest::Node));
            }
            Tok::DotDot => {
                self.next();
                return Ok(type_step(Axis::Parent, NodeTest::Node));
            }
            _ => {}
        }
        let axis = match self.peek().clone() {
            Tok::At => {
                self.next();
                Axis::Attribute
            }
            Tok::AxisName(name) => {
                self.next();
                let Some(axis) = Axis::named(&name) else { return syntax(format!("unknown axis '{name}'")) };
                self.expect(Tok::DoubleColon)?;
                axis
            }
            _ => Axis::Child,
        };
        let test = match self.next() {
            Tok::NodeType(name) => {
                self.expect(Tok::LParen)?;
                let test = match name.as_str() {
                    "node" => NodeTest::Node,
                    "text" => NodeTest::Text,
                    "comment" => NodeTest::Comment,
                    _ => {
                        let literal = match self.peek().clone() {
                            Tok::Literal(l) => {
                                self.next();
                                Some(l)
                            }
                            _ => None,
                        };
                        NodeTest::Pi(literal)
                    }
                };
                self.expect(Tok::RParen)?;
                test
            }
            Tok::NameTest(prefix, local) => NodeTest::Name { lower: local.to_ascii_lowercase(), prefix, local },
            t => return syntax(format!("expected a node test but found {t:?}")),
        };
        let preds = self.predicates()?;
        Ok(Step { axis, test, preds })
    }

    fn predicates(&mut self) -> Result<Vec<Expr>, XError> {
        let mut preds = Vec::new();
        while *self.peek() == Tok::LBracket {
            self.next();
            preds.push(self.expr()?);
            self.expect(Tok::RBracket)?;
        }
        Ok(preds)
    }

    fn filter_expr(&mut self) -> Result<Expr, XError> {
        let primary = match self.next() {
            Tok::VarRef(name) => return syntax(format!("variable references are not supported (${name})")),
            Tok::LParen => {
                let e = self.expr()?;
                self.expect(Tok::RParen)?;
                e
            }
            Tok::Literal(l) => Expr::Literal(l),
            Tok::Number(v) => Expr::Number(v),
            Tok::FuncName(prefix, name) => {
                self.expect(Tok::LParen)?;
                let mut args = Vec::new();
                if *self.peek() != Tok::RParen {
                    args.push(self.expr()?);
                    while *self.peek() == Tok::Comma {
                        self.next();
                        args.push(self.expr()?);
                    }
                }
                self.expect(Tok::RParen)?;
                // (…a function the core library has not, or called with the wrong number of arguments, is no expression:
                // REC §3.2 has a call to one an error, and DOM XPath reports it as INVALID_EXPRESSION_ERR at compile time)
                if let Some(p) = &prefix {
                    return syntax(format!("unknown function: {p}:{name}()"));
                }
                let Some((min, max)) = arity_of(&name) else { return syntax(format!("unknown function: {name}()")) };
                if args.len() < min || args.len() > max {
                    return syntax(format!("{name}() takes {min} to {max} arguments, not {}", args.len()));
                }
                Expr::Func(prefix, name, args)
            }
            t => return syntax(format!("unexpected token {t:?}")),
        };
        let preds = self.predicates()?;
        Ok(if preds.is_empty() { primary } else { Expr::Filter(Box::new(primary), preds) })
    }
}

// The expression's parse, normalized: a `descendant-or-self::node()` + `child::X[preds]` pair (what `//X` expands to)
// fused into `descendant::X[preds]` where no predicate observes position — the same nodes in the same order, without
// materialising every node of the subtree first.
fn parse(text: &[u16]) -> Result<Expr, XError> {
    let mut p = ParserState { toks: tokenize(text)?, pos: 0 };
    let mut e = p.expr()?;
    if *p.peek() != Tok::Eof {
        return syntax(format!("unexpected trailing token {:?}", p.peek()));
    }
    optimize(&mut e);
    Ok(e)
}

fn optimize(e: &mut Expr) {
    match e {
        Expr::Path(root, steps) => {
            if let Root::Expr(r) = root {
                optimize(r);
            }
            for s in steps.iter_mut() {
                s.preds.iter_mut().for_each(optimize);
            }
            let mut i = 0;
            while i + 1 < steps.len() {
                let fuse = steps[i].axis == Axis::DescendantOrSelf
                    && matches!(steps[i].test, NodeTest::Node)
                    && steps[i].preds.is_empty()
                    && steps[i + 1].axis == Axis::Child
                    && steps[i + 1].preds.iter().all(|p| !may_yield_number(p) && !refers_to_position(p));
                if fuse {
                    let next = steps.remove(i + 1);
                    steps[i] = Step { axis: Axis::Descendant, test: next.test, preds: next.preds };
                }
                i += 1;
            }
        }
        Expr::Filter(primary, preds) => {
            optimize(primary);
            preds.iter_mut().for_each(optimize);
        }
        Expr::Binary(_, l, r) => {
            optimize(l);
            optimize(r);
        }
        Expr::Neg(x) => optimize(x),
        Expr::Func(_, _, args) => args.iter_mut().for_each(optimize),
        _ => {}
    }
}

// The number of arguments each function of the core library (REC §4) takes, at least and at most.
fn arity_of(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "last" | "position" | "true" | "false" => (0, 0),
        "count" | "id" | "boolean" | "not" | "lang" | "sum" | "floor" | "ceiling" | "round" => (1, 1),
        "local-name" | "namespace-uri" | "name" | "string" | "string-length" | "normalize-space" | "number" => (0, 1),
        "concat" => (2, usize::MAX),
        "starts-with" | "contains" | "substring-before" | "substring-after" => (2, 2),
        "substring" => (2, 3),
        "translate" => (3, 3),
        _ => return None,
    })
}

// A predicate that is a NUMBER — a proximity-position test.
fn may_yield_number(e: &Expr) -> bool {
    match e {
        Expr::Number(_) | Expr::Neg(_) => true,
        Expr::Binary(op, ..) => matches!(op, Op::Add | Op::Sub | Op::Mul | Op::Div | Op::Mod),
        Expr::Func(None, name, _) => {
            matches!(name.as_str(), "last" | "position" | "count" | "sum" | "floor" | "ceiling" | "round" | "number" | "string-length")
        }
        _ => false,
    }
}

// Whether position() or last() appears anywhere in `e` — over-counting nested ones only forgoes the fusion.
fn refers_to_position(e: &Expr) -> bool {
    match e {
        Expr::Func(None, name, args) => name == "position" || name == "last" || args.iter().any(refers_to_position),
        Expr::Func(_, _, args) => args.iter().any(refers_to_position),
        Expr::Path(root, steps) => {
            matches!(root, Root::Expr(r) if refers_to_position(r)) || steps.iter().any(|s| s.preds.iter().any(refers_to_position))
        }
        Expr::Filter(p, preds) => refers_to_position(p) || preds.iter().any(refers_to_position),
        Expr::Binary(_, l, r) => refers_to_position(l) || refers_to_position(r),
        Expr::Neg(x) => refers_to_position(x),
        _ => false,
    }
}

// The prefixes `e` names in its name tests — what the caller resolves before evaluating.
fn collect_prefixes(e: &Expr, out: &mut Vec<String>) {
    let push = |p: &str, out: &mut Vec<String>| {
        if p != "xml" && !out.iter().any(|q| q == p) {
            out.push(p.to_string());
        }
    };
    match e {
        Expr::Path(root, steps) => {
            if let Root::Expr(r) = root {
                collect_prefixes(r, out);
            }
            for s in steps {
                if let NodeTest::Name { prefix: Some(p), .. } = &s.test {
                    push(p, out);
                }
                for p in &s.preds {
                    collect_prefixes(p, out);
                }
            }
        }
        Expr::Filter(p, preds) => {
            collect_prefixes(p, out);
            preds.iter().for_each(|x| collect_prefixes(x, out));
        }
        Expr::Binary(_, l, r) => {
            collect_prefixes(l, out);
            collect_prefixes(r, out);
        }
        Expr::Neg(x) => collect_prefixes(x, out),
        Expr::Func(_, _, args) => args.iter().for_each(|x| collect_prefixes(x, out)),
        _ => {}
    }
}

// Parsed expressions, by text — Capybara replays a small set many times. Bounded, emptied when full.
thread_local! {
    static PARSED: RefCell<HashMap<Vec<u16>, Rc<Result<(Expr, Vec<String>), String>>>> = RefCell::new(HashMap::new());
}
const PARSED_LIMIT: usize = 1024;

fn parsed(text: &[u16]) -> Rc<Result<(Expr, Vec<String>), String>> {
    if let Some(hit) = PARSED.with(|c| c.borrow().get(text).cloned()) {
        return hit;
    }
    let entry = Rc::new(match parse(text) {
        Ok(e) => {
            let mut prefixes = Vec::new();
            collect_prefixes(&e, &mut prefixes);
            Ok((e, prefixes))
        }
        Err(XError::Syntax(m)) | Err(XError::Type(m)) | Err(XError::Namespace(m)) => Err(m),
    });
    PARSED.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= PARSED_LIMIT {
            c.clear();
        }
        c.insert(text.to_vec(), entry.clone());
    });
    entry
}

// The prefixes `text` names (to resolve before `evaluate`), or the SyntaxError's message.
pub(crate) fn prefixes(text: &[u16]) -> Result<Vec<String>, String> {
    match &*parsed(text) {
        Ok((_, p)) => Ok(p.clone()),
        Err(m) => Err(m.clone()),
    }
}

// ── nodes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// An XPath node: an arena node, or an element's attribute (by its index in the element's list).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum XNode {
    Node(NodeId),
    Attr(NodeId, u32),
}

const ELEMENT: u8 = 1;
const ATTRIBUTE: u8 = 2;
const TEXT: u8 = 3;
const PI: u8 = 7;
const COMMENT: u8 = 8;
const DOCUMENT: u8 = 9;

enum Value {
    Nodes(NodeSet),
    Number(f64),
    Str(Str),
    Bool(bool),
}

struct NodeSet {
    nodes: Vec<XNode>,
    sorted: bool,
}

impl NodeSet {
    fn new(nodes: Vec<XNode>, sorted: bool) -> NodeSet {
        NodeSet { nodes, sorted }
    }
}

// One evaluation: the arena, the document's kind, the root of the context's tree (what `/` and id() search — a
// detached subtree's own root, as Blink has it), the resolved prefixes, and what it memoizes while the tree holds still.
struct Eval<'a> {
    arena: &'a RealmArena,
    html: bool,
    root: NodeId,
    namespaces: &'a HashMap<String, String>,
    string_values: RefCell<HashMap<XNode, Rc<Str>>>,
    absolute: RefCell<HashMap<*const Expr, Rc<Vec<XNode>>>>,
}

struct Ctx {
    node: XNode,
    position: usize,
    size: usize,
}

impl<'a> Eval<'a> {
    fn data(&self, id: NodeId) -> Option<&'a crate::dom::NodeData> {
        self.arena.get(id)
    }

    fn node_type(&self, x: XNode) -> u8 {
        match x {
            XNode::Attr(..) => ATTRIBUTE,
            XNode::Node(id) => match self.data(id).map(|n| n.kind) {
                Some(NodeKind::Element) => ELEMENT,
                Some(NodeKind::Text) => TEXT,
                Some(NodeKind::Comment) => COMMENT,
                Some(NodeKind::ProcessingInstruction) => PI,
                Some(NodeKind::Document) => DOCUMENT,
                Some(NodeKind::Fragment) => 11,
                _ => 10,
            },
        }
    }

    fn parent(&self, x: XNode) -> Option<XNode> {
        match x {
            XNode::Attr(owner, _) => Some(XNode::Node(owner)),
            XNode::Node(id) => self.arena.parent_of(id).map(XNode::Node),
        }
    }

    // A node's children in the XPath data model: no doctype.
    fn children(&self, x: XNode) -> impl Iterator<Item = XNode> + 'a {
        let kids: &'a [NodeId] = match x {
            XNode::Node(id) => self.data(id).map_or(&[][..], |n| &n.children[..]),
            XNode::Attr(..) => &[],
        };
        let arena = self.arena;
        kids.iter().copied().filter(move |&c| arena.get(c).is_some_and(|n| n.kind != NodeKind::Other)).map(XNode::Node)
    }

    // An element's attributes, without its namespace declarations — which are namespace nodes in the data model, not
    // attributes (REC §5.3).
    fn attributes(&self, id: NodeId) -> impl Iterator<Item = XNode> + 'a {
        let n = self.data(id).filter(|n| n.kind == NodeKind::Element);
        let attrs = n.map_or(&[][..], |n| &n.attributes[..]);
        attrs
            .iter()
            .enumerate()
            .filter(move |(_, (key, _))| n.is_some_and(|n| n.attribute_name(key).0 != XMLNS_NS))
            .map(move |(i, _)| XNode::Attr(id, i as u32))
    }

    // (namespace, local name) of an element or attribute.
    fn expanded_name(&self, x: XNode) -> (&'a str, &'a str) {
        match x {
            XNode::Node(id) => self.data(id).map_or(("", ""), |n| (&*n.ns, &*n.local_name)),
            XNode::Attr(owner, i) => {
                let Some(n) = self.data(owner) else { return ("", "") };
                let key = &n.attributes[i as usize].0;
                n.attribute_name(key)
            }
        }
    }

    // DOM nodeName: an element's qualified name (upper-cased, an HTML element in an HTML document), an attribute's
    // qualified name, a processing instruction's target.
    fn node_name(&self, x: XNode) -> Str {
        match x {
            XNode::Node(id) => {
                let Some(n) = self.data(id) else { return Vec::new() };
                match n.kind {
                    NodeKind::Element => {
                        let mut q = match &n.prefix {
                            Some(p) => format!("{p}:{}", &*n.local_name),
                            None => n.local_name.to_string(),
                        };
                        if self.html && &*n.ns == HTML_NS {
                            q.make_ascii_uppercase();
                        }
                        utf16(&q)
                    }
                    NodeKind::ProcessingInstruction => utf16(&n.local_name),
                    _ => Vec::new(),
                }
            }
            XNode::Attr(owner, i) => {
                let Some(n) = self.data(owner) else { return Vec::new() };
                let key = &n.attributes[i as usize].0;
                utf16(key.split('\0').next().unwrap_or(key))
            }
        }
    }

    fn string_value(&self, x: XNode) -> Rc<Str> {
        if let Some(v) = self.string_values.borrow().get(&x) {
            return v.clone();
        }
        let v: Str = match x {
            XNode::Attr(owner, i) => self.data(owner).map_or_else(Vec::new, |n| {
                let (key, value) = &n.attributes[i as usize];
                n.get_attr_u16(key).map_or_else(|| utf16(value), <[u16]>::to_vec)
            }),
            XNode::Node(id) => match self.data(id) {
                None => Vec::new(),
                Some(n) => match n.kind {
                    NodeKind::Text | NodeKind::Comment | NodeKind::ProcessingInstruction => n.data.clone(),
                    NodeKind::Element | NodeKind::Document | NodeKind::Fragment => {
                        let mut out = Vec::new();
                        let mut stack: Vec<NodeId> = n.children.iter().rev().copied().collect();
                        while let Some(c) = stack.pop() {
                            let Some(k) = self.data(c) else { continue };
                            match k.kind {
                                NodeKind::Text => out.extend_from_slice(&k.data),
                                NodeKind::Element => stack.extend(k.children.iter().rev().copied()),
                                _ => {}
                            }
                        }
                        out
                    }
                    _ => Vec::new(),
                },
            },
        };
        let v = Rc::new(v);
        self.string_values.borrow_mut().insert(x, v.clone());
        v
    }

    // The attribute (`ns`, `local`) of an element, as an XPath value — None where it has none.
    fn attribute_value(&self, id: NodeId, ns: &str, local: &str) -> Option<XNode> {
        let n = self.data(id).filter(|n| n.kind == NodeKind::Element)?;
        n.attributes.iter().position(|(key, _)| n.attribute_name(key) == (ns, local)).map(|i| XNode::Attr(id, i as u32))
    }

    // ── document order ──
    // A node's path from its tree's root, as child indexes (an attribute after its element, by index, before its
    // children) — compared lexicographically. Nodes of different trees order by their roots' ids, consistently.
    fn order_key(&self, x: XNode) -> (u64, Vec<u32>) {
        let (mut id, attr) = match x {
            XNode::Node(id) => (id, None),
            XNode::Attr(owner, i) => (owner, Some(i)),
        };
        let mut path = Vec::new();
        if let Some(i) = attr {
            path.push(i);
            path.push(0);
        }
        while let Some(p) = self.arena.parent_of(id) {
            let idx = self.data(p).and_then(|pn| pn.children.iter().position(|&c| c == id)).unwrap_or(0);
            path.push(idx as u32 + 1);
            id = p;
        }
        path.reverse();
        (id.to_f64().to_bits(), path)
    }

    fn sort(&self, nodes: &mut Vec<XNode>) {
        if nodes.len() < 2 {
            return;
        }
        let mut keyed: Vec<((u64, Vec<u32>), XNode)> = nodes.iter().map(|&x| (self.order_key(x), x)).collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        *nodes = keyed.into_iter().map(|(_, x)| x).collect();
    }

    fn ordered<'s>(&self, ns: &'s mut NodeSet) -> &'s [XNode] {
        if !ns.sorted {
            self.sort(&mut ns.nodes);
            ns.sorted = true;
        }
        &ns.nodes
    }

    fn first(&self, ns: &NodeSet) -> Option<XNode> {
        match ns.nodes.len() {
            0 => None,
            1 => Some(ns.nodes[0]),
            _ if ns.sorted => Some(ns.nodes[0]),
            _ => ns.nodes.iter().copied().min_by(|a, b| self.order_key(*a).cmp(&self.order_key(*b))),
        }
    }

    // ── conversions (REC §4) ──
    fn to_bool(&self, v: &Value) -> bool {
        match v {
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::Nodes(ns) => !ns.nodes.is_empty(),
        }
    }
    fn to_num(&self, v: &Value) -> f64 {
        match v {
            Value::Number(n) => *n,
            Value::Bool(b) => f64::from(u8::from(*b)),
            Value::Str(s) => str_to_number(s),
            Value::Nodes(ns) => str_to_number(&self.nodeset_string(ns)),
        }
    }
    fn to_str(&self, v: &Value) -> Str {
        match v {
            Value::Str(s) => s.clone(),
            Value::Number(n) => utf16(&number_to_string(*n)),
            Value::Bool(b) => utf16(if *b { "true" } else { "false" }),
            Value::Nodes(ns) => self.nodeset_string(ns),
        }
    }
    fn nodeset_string(&self, ns: &NodeSet) -> Str {
        self.first(ns).map_or_else(Vec::new, |x| (*self.string_value(x)).clone())
    }

    // ── evaluation ──
    fn eval(&self, e: &Expr, ctx: &Ctx) -> Result<Value, XError> {
        match e {
            Expr::Literal(s) => Ok(Value::Str(s.clone())),
            Expr::Number(n) => Ok(Value::Number(*n)),
            Expr::Neg(x) => Ok(Value::Number(-self.to_num(&self.eval(x, ctx)?))),
            Expr::Binary(op, l, r) => self.binary(*op, l, r, ctx),
            Expr::Path(root, steps) => Ok(Value::Nodes(self.path(e, root, steps, ctx)?)),
            Expr::Filter(primary, preds) => {
                let Value::Nodes(mut ns) = self.eval(primary, ctx)? else {
                    return type_err("a predicate applied to a value that is not a node-set");
                };
                let nodes = self.ordered(&mut ns).to_vec();
                Ok(Value::Nodes(NodeSet::new(self.apply_predicates(nodes, preds)?, true)))
            }
            Expr::Func(_, name, args) => self.function(name, args, ctx),
        }
    }

    fn binary(&self, op: Op, l: &Expr, r: &Expr, ctx: &Ctx) -> Result<Value, XError> {
        match op {
            Op::Or => Ok(Value::Bool(self.to_bool(&self.eval(l, ctx)?) || self.to_bool(&self.eval(r, ctx)?))),
            Op::And => Ok(Value::Bool(self.to_bool(&self.eval(l, ctx)?) && self.to_bool(&self.eval(r, ctx)?))),
            Op::Union => {
                let (Value::Nodes(a), Value::Nodes(b)) = (self.eval(l, ctx)?, self.eval(r, ctx)?) else {
                    return type_err("a union operand is not a node-set");
                };
                if b.nodes.is_empty() {
                    return Ok(Value::Nodes(NodeSet::new(a.nodes, a.sorted)));
                }
                if a.nodes.is_empty() {
                    return Ok(Value::Nodes(NodeSet::new(b.nodes, b.sorted)));
                }
                let mut seen: HashSet<XNode> = a.nodes.iter().copied().collect();
                let mut nodes = a.nodes;
                nodes.extend(b.nodes.into_iter().filter(|x| seen.insert(*x)));
                Ok(Value::Nodes(NodeSet::new(nodes, false)))
            }
            Op::Eq | Op::Ne | Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                if let Some(fast) = self.attribute_comparison(op, l, r, ctx)? {
                    return Ok(Value::Bool(fast));
                }
                let (a, b) = (self.eval(l, ctx)?, self.eval(r, ctx)?);
                Ok(Value::Bool(if matches!(op, Op::Eq | Op::Ne) { self.equality(op, &a, &b) } else { self.relational(op, &a, &b) }))
            }
            _ => {
                let (a, b) = (self.to_num(&self.eval(l, ctx)?), self.to_num(&self.eval(r, ctx)?));
                Ok(Value::Number(match op {
                    Op::Add => a + b,
                    Op::Sub => a - b,
                    Op::Mul => a * b,
                    Op::Div => a / b,
                    _ => a % b,
                }))
            }
        }
    }

    // `@name <op> literal` (either way round) — the dominant Capybara predicate — read off the element without an
    // attribute-axis node-set. None for any other shape.
    fn attribute_comparison(&self, op: Op, l: &Expr, r: &Expr, ctx: &Ctx) -> Result<Option<bool>, XError> {
        let (test, literal, op) = match (simple_attribute_test(l), constant(r), simple_attribute_test(r), constant(l)) {
            (Some(t), Some(c), _, _) => (t, c, op),
            (_, _, Some(t), Some(c)) => (t, c, flip(op)),
            _ => return Ok(None),
        };
        let XNode::Node(id) = ctx.node else { return Ok(Some(false)) };
        let Some(attr) = self.named_attribute(id, test)? else { return Ok(Some(false)) };
        let value = self.string_value(attr);
        Ok(Some(match (op, literal) {
            (Op::Eq, Constant::Str(s)) => *value == *s,
            (Op::Ne, Constant::Str(s)) => *value != *s,
            (Op::Eq, Constant::Num(n)) => str_to_number(&value) == n,
            (Op::Ne, Constant::Num(n)) => str_to_number(&value) != n,
            (op, c) => {
                let b = match c {
                    Constant::Num(n) => n,
                    Constant::Str(s) => str_to_number(s),
                };
                relate(op, str_to_number(&value), b)
            }
        }))
    }

    // The attribute a concrete `@name` / `@prefix:name` test names on element `id` — `matches`' rule, by lookup.
    fn named_attribute(&self, id: NodeId, test: AttrTest<'_>) -> Result<Option<XNode>, XError> {
        match test.prefix {
            Some(prefix) => {
                let ns = self.resolve(prefix)?;
                Ok(self.attribute_value(id, &ns, test.local))
            }
            None if self.html && self.data(id).is_some_and(|n| &*n.ns == HTML_NS) => Ok(self.attribute_value(id, "", test.lower)),
            None => Ok(self.attribute_value(id, "", test.local)),
        }
    }

    fn resolve(&self, prefix: &str) -> Result<String, XError> {
        if prefix == "xml" {
            return Ok(XML_NS.to_string());
        }
        match self.namespaces.get(prefix) {
            Some(uri) => Ok(uri.clone()),
            None => Err(XError::Namespace(format!("unresolved namespace prefix '{prefix}'"))),
        }
    }

    // `=` / `!=` (REC §3.4): existential over node-sets.
    fn equality(&self, op: Op, a: &Value, b: &Value) -> bool {
        let test = |x: bool| if op == Op::Eq { x } else { !x };
        match (a, b) {
            (Value::Nodes(x), Value::Nodes(y)) => {
                let ys: Vec<Rc<Str>> = y.nodes.iter().map(|&n| self.string_value(n)).collect();
                x.nodes.iter().any(|&n| {
                    let s = self.string_value(n);
                    ys.iter().any(|t| test(*s == **t))
                })
            }
            (Value::Nodes(ns), other) | (other, Value::Nodes(ns)) => match other {
                Value::Bool(bv) => test((!ns.nodes.is_empty()) == *bv),
                Value::Number(nv) => ns.nodes.iter().any(|&n| test(str_to_number(&self.string_value(n)) == *nv)),
                _ => {
                    let s = self.to_str(other);
                    ns.nodes.iter().any(|&n| test(*self.string_value(n) == s))
                }
            },
            _ if matches!(a, Value::Bool(_)) || matches!(b, Value::Bool(_)) => test(self.to_bool(a) == self.to_bool(b)),
            _ if matches!(a, Value::Number(_)) || matches!(b, Value::Number(_)) => test(self.to_num(a) == self.to_num(b)),
            _ => test(self.to_str(a) == self.to_str(b)),
        }
    }

    // `<` / `<=` / `>` / `>=`: both sides as numbers, a node-set's members each.
    fn relational(&self, op: Op, a: &Value, b: &Value) -> bool {
        let nums = |v: &Value| -> Vec<f64> {
            match v {
                Value::Nodes(ns) => ns.nodes.iter().map(|&n| str_to_number(&self.string_value(n))).collect(),
                v => vec![self.to_num(v)],
            }
        };
        let (xs, ys) = (nums(a), nums(b));
        xs.iter().any(|&x| ys.iter().any(|&y| relate(op, x, y)))
    }

    fn path(&self, e: &Expr, root: &Root, steps: &[Step], ctx: &Ctx) -> Result<NodeSet, XError> {
        // (…an absolute path is the same for every context of one document: computed once per evaluation)
        let key = e as *const Expr;
        if matches!(root, Root::Document) {
            if let Some(hit) = self.absolute.borrow().get(&key) {
                return Ok(NodeSet::new((**hit).clone(), false));
            }
        }
        let mut current: Vec<XNode> = match root {
            Root::Context => vec![ctx.node],
            Root::Document => vec![XNode::Node(self.root)],
            Root::Expr(r) => match self.eval(r, ctx)? {
                Value::Nodes(ns) => ns.nodes,
                _ => return type_err("the left-hand side of a path step is not a node-set"),
            },
        };
        for step in steps {
            current = self.step(step, &current)?;
        }
        if matches!(root, Root::Document) {
            self.absolute.borrow_mut().insert(key, Rc::new(current.clone()));
        }
        Ok(NodeSet::new(current, false))
    }

    fn step(&self, step: &Step, input: &[XNode]) -> Result<Vec<XNode>, XError> {
        let mut out = Vec::new();
        if input.is_empty() {
            return Ok(out);
        }
        let mut seen: Option<HashSet<XNode>> = (input.len() > 1 && !step.axis.disjoint()).then(HashSet::new);
        for &node in input {
            let mut candidates = Vec::new();
            match step.axis {
                Axis::Descendant | Axis::DescendantOrSelf => {
                    // (…the test fused into the walk: the full descendant set is never built just to be filtered)
                    if step.axis == Axis::DescendantOrSelf && self.matches(node, &step.test, step.axis)? {
                        candidates.push(node);
                    }
                    let mut stack: Vec<XNode> = self.children(node).collect::<Vec<_>>();
                    stack.reverse();
                    while let Some(n) = stack.pop() {
                        if self.matches(n, &step.test, step.axis)? {
                            candidates.push(n);
                        }
                        let before = stack.len();
                        stack.extend(self.children(n));
                        stack[before..].reverse();
                    }
                }
                axis => {
                    for n in self.axis(node, axis) {
                        if self.matches(n, &step.test, axis)? {
                            candidates.push(n);
                        }
                    }
                }
            }
            if !step.preds.is_empty() {
                candidates = self.apply_predicates(candidates, &step.preds)?;
            }
            match &mut seen {
                Some(seen) => out.extend(candidates.into_iter().filter(|x| seen.insert(*x))),
                None => out.extend(candidates),
            }
        }
        Ok(out)
    }

    // An axis's nodes from `x`, in axis order (a reverse axis in reverse document order).
    fn axis(&self, x: XNode, axis: Axis) -> Vec<XNode> {
        // (…a node's siblings of every kind but a doctype, as `children` has them — not the arena's ELEMENT siblings)
        let siblings = |x: XNode, forward: bool| -> Vec<XNode> {
            let XNode::Node(id) = x else { return Vec::new() };
            let Some(kids) = self.arena.parent_of(id).and_then(|p| self.data(p)).map(|p| &p.children) else { return Vec::new() };
            let held = self.data(id).map(|n| n.child_index).filter(|&i| kids.get(i) == Some(&id));
            let Some(at) = held.or_else(|| kids.iter().position(|&c| c == id)) else { return Vec::new() };
            let live = |&c: &NodeId| self.data(c).is_some_and(|n| n.kind != NodeKind::Other);
            let out: Vec<XNode> = if forward {
                kids[at + 1..].iter().filter(|c| live(c)).map(|&c| XNode::Node(c)).collect()
            } else {
                kids[..at].iter().rev().filter(|c| live(c)).map(|&c| XNode::Node(c)).collect()
            };
            out
        };
        let descendants = |x: XNode, out: &mut Vec<XNode>| {
            let mut stack: Vec<XNode> = self.children(x).collect();
            stack.reverse();
            while let Some(n) = stack.pop() {
                out.push(n);
                let before = stack.len();
                stack.extend(self.children(n));
                stack[before..].reverse();
            }
        };
        match axis {
            Axis::SelfAxis => vec![x],
            Axis::Child => self.children(x).collect(),
            Axis::Parent => self.parent(x).into_iter().collect(),
            Axis::Ancestor | Axis::AncestorOrSelf => {
                let mut out = if axis == Axis::AncestorOrSelf { vec![x] } else { Vec::new() };
                let mut p = self.parent(x);
                while let Some(n) = p {
                    out.push(n);
                    p = self.parent(n);
                }
                out
            }
            Axis::FollowingSibling => siblings(x, true),
            Axis::PrecedingSibling => siblings(x, false),
            Axis::Following | Axis::Preceding => {
                let forward = axis == Axis::Following;
                let mut out = Vec::new();
                // (…an attribute's following / preceding are its element's, children included for following)
                let mut cur = match x {
                    XNode::Attr(owner, _) => {
                        if forward {
                            descendants(XNode::Node(owner), &mut out);
                        }
                        Some(XNode::Node(owner))
                    }
                    n => Some(n),
                };
                while let Some(c) = cur {
                    if self.node_type(c) == DOCUMENT {
                        break;
                    }
                    for s in siblings(c, forward) {
                        out.push(s);
                        descendants(s, &mut out);
                    }
                    cur = self.parent(c);
                }
                self.sort(&mut out);
                if !forward {
                    out.reverse();
                }
                out
            }
            Axis::Attribute => match x {
                XNode::Node(id) => self.attributes(id).collect(),
                XNode::Attr(..) => Vec::new(),
            },
            Axis::Namespace | Axis::Descendant | Axis::DescendantOrSelf => {
                if axis == Axis::Namespace {
                    return Vec::new();
                }
                let mut out = if axis == Axis::DescendantOrSelf { vec![x] } else { Vec::new() };
                descendants(x, &mut out);
                out
            }
        }
    }

    // A node test (REC §2.3), with the HTML document's case rule.
    fn matches(&self, x: XNode, test: &NodeTest, axis: Axis) -> Result<bool, XError> {
        let t = self.node_type(x);
        Ok(match test {
            NodeTest::Node => t != 10,
            NodeTest::Text => t == TEXT,
            NodeTest::Comment => t == COMMENT,
            NodeTest::Pi(target) => t == PI && target.as_ref().is_none_or(|lit| self.node_name(x) == *lit),
            NodeTest::Name { prefix, local, lower } => {
                if axis == Axis::Namespace {
                    return Ok(false);
                }
                let principal = if axis == Axis::Attribute { ATTRIBUTE } else { ELEMENT };
                if t != principal {
                    return Ok(false);
                }
                match prefix {
                    None if local == "*" => true,
                    None => {
                        // (…in an HTML document an unprefixed ELEMENT test names the HTML namespace, ASCII-lowercased, and an
                        // attribute test of an HTML element is ASCII-lowercased: compared exactly after — a no-namespace
                        // element is matched by no unprefixed test there, and an attribute set mixed-case by
                        // `setAttributeNS` by none)
                        let (ns, name) = self.expanded_name(x);
                        match x {
                            XNode::Node(_) if self.html => ns == HTML_NS && name == lower,
                            XNode::Attr(owner, _) if self.html && self.data(owner).is_some_and(|n| &*n.ns == HTML_NS) => {
                                ns.is_empty() && name == lower
                            }
                            _ => ns.is_empty() && name == local,
                        }
                    }
                    Some(p) => {
                        let uri = self.resolve(p)?;
                        let (ns, name) = self.expanded_name(x);
                        ns == uri && (local == "*" || name == local)
                    }
                }
            }
        })
    }

    // Each predicate in turn over `nodes` (axis order): a number selects that proximity position, anything else is
    // taken as a boolean (REC §2.4).
    fn apply_predicates(&self, mut nodes: Vec<XNode>, preds: &[Expr]) -> Result<Vec<XNode>, XError> {
        for pred in preds {
            let size = nodes.len();
            let existence = is_pure_node_set(pred);
            let mut kept = Vec::with_capacity(size);
            for (i, &node) in nodes.iter().enumerate() {
                let ctx = Ctx { node, position: i + 1, size };
                let keep = if existence {
                    self.exists(pred, &ctx)?
                } else {
                    match self.eval(pred, &ctx)? {
                        Value::Number(n) => n == (i + 1) as f64,
                        v => self.to_bool(&v),
                    }
                };
                if keep {
                    kept.push(node);
                }
            }
            nodes = kept;
        }
        Ok(nodes)
    }

    // Whether a node-set expression selects anything, short-circuiting: `self::a | self::b` is a name test on the
    // context node, `@x` a lookup.
    fn exists(&self, e: &Expr, ctx: &Ctx) -> Result<bool, XError> {
        match e {
            Expr::Binary(Op::Union, l, r) => Ok(self.exists(l, ctx)? || self.exists(r, ctx)?),
            Expr::Path(..) => {
                if let Some(step) = single_relative_step(e).filter(|s| s.preds.is_empty()) {
                    if step.axis == Axis::SelfAxis {
                        return self.matches(ctx.node, &step.test, Axis::SelfAxis);
                    }
                    if let Some(test) = attribute_test(step) {
                        let XNode::Node(id) = ctx.node else { return Ok(false) };
                        return Ok(self.named_attribute(id, test)?.is_some());
                    }
                }
                Ok(matches!(self.eval(e, ctx)?, Value::Nodes(ns) if !ns.nodes.is_empty()))
            }
            _ => Ok(self.to_bool(&self.eval(e, ctx)?)),
        }
    }

    // ── the core function library (REC §4) ──
    fn function(&self, name: &str, args: &[Expr], ctx: &Ctx) -> Result<Value, XError> {
        let arg = |i: usize| self.eval(&args[i], ctx);
        let string_arg = |i: usize| -> Result<Str, XError> { Ok(self.to_str(&arg(i)?)) };
        let num_arg = |i: usize| -> Result<f64, XError> { Ok(self.to_num(&arg(i)?)) };
        let nodes_arg = |i: usize| -> Result<NodeSet, XError> {
            match arg(i)? {
                Value::Nodes(ns) => Ok(ns),
                _ => type_err(format!("{name}() requires a node-set argument")),
            }
        };
        // (the context node, or the first node of the argument)
        let target = || -> Result<Option<XNode>, XError> {
            if args.is_empty() { Ok(Some(ctx.node)) } else { Ok(self.first(&nodes_arg(0)?)) }
        };
        let target_string = || -> Result<Str, XError> {
            if args.is_empty() { Ok((*self.string_value(ctx.node)).clone()) } else { string_arg(0) }
        };
        Ok(match name {
            "last" => {
                Value::Number(ctx.size as f64)
            }
            "position" => {
                Value::Number(ctx.position as f64)
            }
            "count" => {
                Value::Number(nodes_arg(0)?.nodes.len() as f64)
            }
            "id" => {
                let tokens: Vec<Str> = match arg(0)? {
                    Value::Nodes(ns) => ns.nodes.iter().flat_map(|&n| split_ws(&self.string_value(n))).collect(),
                    v => split_ws(&self.to_str(&v)),
                };
                Value::Nodes(NodeSet::new(self.elements_by_id(tokens), true))
            }
            "local-name" | "namespace-uri" | "name" => {
                let Some(node) = target()? else { return Ok(Value::Str(Vec::new())) };
                let t = self.node_type(node);
                Value::Str(match (name, t) {
                    ("local-name", ELEMENT | ATTRIBUTE) => utf16(self.expanded_name(node).1),
                    ("local-name", PI) => self.node_name(node),
                    ("namespace-uri", ELEMENT | ATTRIBUTE) => utf16(self.expanded_name(node).0),
                    ("name", ELEMENT | ATTRIBUTE | PI) => self.node_name(node),
                    _ => Vec::new(),
                })
            }
            "string" => Value::Str(target_string()?),
            "concat" => {
                let mut out = Vec::new();
                for i in 0..args.len() {
                    out.extend(string_arg(i)?);
                }
                Value::Str(out)
            }
            "starts-with" => {
                Value::Bool(string_arg(0)?.starts_with(&string_arg(1)?))
            }
            "contains" => {
                Value::Bool(find(&string_arg(0)?, &string_arg(1)?).is_some())
            }
            "substring-before" | "substring-after" => {
                let (s, sub) = (string_arg(0)?, string_arg(1)?);
                Value::Str(match find(&s, &sub) {
                    None => Vec::new(),
                    Some(i) if name == "substring-before" => s[..i].to_vec(),
                    Some(i) => s[i + sub.len()..].to_vec(),
                })
            }
            "substring" => {
                let s = string_arg(0)?;
                let lo = xpath_round(num_arg(1)?);
                let hi = if args.len() == 3 { lo + xpath_round(num_arg(2)?) } else { f64::INFINITY };
                Value::Str(
                    s.iter().enumerate().filter(|(i, _)| { let p = (*i + 1) as f64; p >= lo && p < hi }).map(|(_, &c)| c).collect(),
                )
            }
            "string-length" => Value::Number(target_string()?.len() as f64),
            "normalize-space" => Value::Str(normalize_space(&target_string()?)),
            "translate" => {
                let (s, from, to) = (string_arg(0)?, string_arg(1)?, string_arg(2)?);
                Value::Str(
                    s.into_iter()
                        .filter_map(|c| match from.iter().position(|&f| f == c) {
                            None => Some(c),
                            Some(j) => to.get(j).copied(),
                        })
                        .collect(),
                )
            }
            "boolean" => {
                Value::Bool(self.to_bool(&arg(0)?))
            }
            "not" => {
                Value::Bool(!self.to_bool(&arg(0)?))
            }
            "true" | "false" => {
                Value::Bool(name == "true")
            }
            "lang" => {
                let target = String::from_utf16_lossy(&string_arg(0)?).to_ascii_lowercase();
                let mut lang = None;
                let mut cur = Some(ctx.node);
                while let Some(n) = cur {
                    if let XNode::Node(id) = n {
                        if let Some(attr) = self.attribute_value(id, XML_NS, "lang") {
                            lang = Some(String::from_utf16_lossy(&self.string_value(attr)).to_ascii_lowercase());
                            break;
                        }
                    }
                    cur = self.parent(n);
                }
                Value::Bool(lang.is_some_and(|l| l == target || l.starts_with(&format!("{target}-"))))
            }
            "number" => {
                Value::Number(if args.is_empty() { str_to_number(&self.string_value(ctx.node)) } else { num_arg(0)? })
            }
            "sum" => {
                Value::Number(nodes_arg(0)?.nodes.iter().map(|&n| str_to_number(&self.string_value(n))).sum())
            }
            "floor" => {
                Value::Number(num_arg(0)?.floor())
            }
            "ceiling" => {
                Value::Number(num_arg(0)?.ceil())
            }
            "round" => {
                Value::Number(xpath_round(num_arg(0)?))
            }
            _ => unreachable!("a function the parser admits: {name}()"),
        })
    }

    // Every element of the context's tree whose ID is one of `ids`, in document order — a duplicate ID's every element.
    fn elements_by_id(&self, ids: Vec<Str>) -> Vec<XNode> {
        let mut out = Vec::new();
        if ids.is_empty() {
            return out;
        }
        let wanted: HashSet<String> = ids.iter().map(|t| String::from_utf16_lossy(t)).collect();
        // (…from the root itself, which is an element in a detached tree)
        let mut stack = vec![self.root];
        while let Some(c) = stack.pop() {
            let Some(n) = self.data(c) else { continue };
            match n.kind {
                NodeKind::Element => {
                    if n.plain_attr("id").is_some_and(|v| wanted.contains(v)) {
                        out.push(XNode::Node(c));
                    }
                }
                NodeKind::Document | NodeKind::Fragment => {}
                _ => continue,
            }
            stack.extend(n.children.iter().rev().copied());
        }
        out
    }
}

enum Constant<'e> {
    Str(&'e Str),
    Num(f64),
}

fn constant(e: &Expr) -> Option<Constant<'_>> {
    match e {
        Expr::Literal(s) => Some(Constant::Str(s)),
        Expr::Number(n) => Some(Constant::Num(*n)),
        _ => None,
    }
}

// The one effective step of a context-relative path, a leading `self::node()` (`./@id`) allowed.
fn single_relative_step(e: &Expr) -> Option<&Step> {
    let Expr::Path(Root::Context, steps) = e else { return None };
    match steps.as_slice() {
        [s] => Some(s),
        [a, s] if a.axis == Axis::SelfAxis && matches!(a.test, NodeTest::Node) && a.preds.is_empty() => Some(s),
        _ => None,
    }
}

// A concrete attribute name test: `@name` / `@prefix:name`.
#[derive(Clone, Copy)]
struct AttrTest<'e> {
    prefix: &'e Option<String>,
    local: &'e str,
    lower: &'e str,
}

// The step's, where it is an attribute step with a concrete name and no predicate.
fn attribute_test(s: &Step) -> Option<AttrTest<'_>> {
    match (&s.axis, &s.test) {
        (Axis::Attribute, NodeTest::Name { prefix, local, lower }) if s.preds.is_empty() && local != "*" => {
            Some(AttrTest { prefix, local, lower })
        }
        _ => None,
    }
}

// A relative `@name` / `./@name` step with a concrete name and no predicate.
fn simple_attribute_test(e: &Expr) -> Option<AttrTest<'_>> {
    attribute_test(single_relative_step(e)?)
}

fn is_pure_node_set(e: &Expr) -> bool {
    match e {
        Expr::Path(..) | Expr::Filter(..) => true,
        Expr::Binary(Op::Union, l, r) => is_pure_node_set(l) && is_pure_node_set(r),
        _ => false,
    }
}

fn flip(op: Op) -> Op {
    match op {
        Op::Lt => Op::Gt,
        Op::Gt => Op::Lt,
        Op::Le => Op::Ge,
        Op::Ge => Op::Le,
        op => op,
    }
}

fn relate(op: Op, a: f64, b: f64) -> bool {
    match op {
        Op::Lt => a < b,
        Op::Le => a <= b,
        Op::Gt => a > b,
        _ => a >= b,
    }
}

fn is_xml_ws(c: u16) -> bool {
    matches!(c, 0x20 | 0x09 | 0x0d | 0x0a)
}

fn split_ws(s: &[u16]) -> Vec<Str> {
    s.split(|&c| is_xml_ws(c)).filter(|t| !t.is_empty()).map(<[u16]>::to_vec).collect()
}

fn normalize_space(s: &[u16]) -> Str {
    let mut out = Vec::with_capacity(s.len());
    for token in s.split(|&c| is_xml_ws(c)).filter(|t| !t.is_empty()) {
        if !out.is_empty() {
            out.push(0x20);
        }
        out.extend_from_slice(token);
    }
    out
}

fn find(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// round() (REC §4.4): the nearest integer, ties toward +∞; NaN and the infinities as they are.
fn xpath_round(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return x;
    }
    let r = (x + 0.5).floor();
    if r == 0.0 && x.is_sign_negative() { -0.0 } else { r }
}

// number(string) (REC §4.4): optional whitespace, an optional `-`, Digits ('.' Digits?)? | '.' Digits — else NaN.
fn str_to_number(s: &[u16]) -> f64 {
    let s: Vec<u16> = {
        let start = s.iter().position(|&c| !is_xml_ws(c)).unwrap_or(s.len());
        let end = s.iter().rposition(|&c| !is_xml_ws(c)).map_or(start, |e| e + 1);
        s[start..end].to_vec()
    };
    let body = s.strip_prefix(&[b'-' as u16][..]).unwrap_or(&s);
    let digits = |t: &[u16]| t.iter().all(|&c| (b'0' as u16..=b'9' as u16).contains(&c));
    let valid = match body.iter().position(|&c| c == b'.' as u16) {
        None => !body.is_empty() && digits(body),
        Some(dot) => {
            let (int, frac) = (&body[..dot], &body[dot + 1..]);
            digits(int) && digits(frac) && !(int.is_empty() && frac.is_empty())
        }
    };
    if !valid {
        return f64::NAN;
    }
    String::from_utf16_lossy(&s).parse::<f64>().unwrap_or(f64::NAN)
}

// string(number) (REC §4.2): no exponent, an integer without a decimal point, NaN / Infinity / -Infinity spelled out.
fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == 0.0 {
        return "0".into();
    }
    // (Rust's Display is the shortest round-trip decimal, never in exponent form — what the REC asks for)
    format!("{n}")
}

// ── the entry point ──────────────────────────────────────────────────────────────────────────────────────────────

// What an evaluation answers: a node-set in document order, or the value converted to the type asked for.
pub(crate) enum Answer {
    Nodes(Vec<XNode>),
    Number(f64),
    Str(Str),
    Bool(bool),
}

// XPathResult's type codes (DOM XPath): ANY_TYPE, then NUMBER / STRING / BOOLEAN; every other one wants a node-set.
const ANY_TYPE: u8 = 0;
const NUMBER_TYPE: u8 = 1;
const STRING_TYPE: u8 = 2;
const BOOLEAN_TYPE: u8 = 3;

// Evaluate `text` with `context` as the context node, in an HTML document or not, the prefixes it names resolved in
// `namespaces`; the value as `result_type` asks for it — a TypeError where a node-set is asked of another value.
pub(crate) fn evaluate(
    arena: &RealmArena,
    text: &[u16],
    context: XNode,
    html: bool,
    namespaces: &HashMap<String, String>,
    result_type: u8,
) -> Result<Answer, XError> {
    let entry = parsed(text);
    let (expr, _) = match &*entry {
        Ok(p) => p,
        Err(m) => return Err(XError::Syntax(m.clone())),
    };
    let mut root = match context {
        XNode::Node(id) | XNode::Attr(id, _) => id,
    };
    while let Some(p) = arena.parent_of(root) {
        root = p;
    }
    let eval = Eval {
        arena,
        html,
        root,
        namespaces,
        string_values: RefCell::new(HashMap::new()),
        absolute: RefCell::new(HashMap::new()),
    };
    let value = eval.eval(expr, &Ctx { node: context, position: 1, size: 1 })?;
    Ok(match (result_type, value) {
        (ANY_TYPE, Value::Number(n)) | (NUMBER_TYPE, Value::Number(n)) => Answer::Number(n),
        (ANY_TYPE, Value::Str(s)) | (STRING_TYPE, Value::Str(s)) => Answer::Str(s),
        (ANY_TYPE, Value::Bool(b)) | (BOOLEAN_TYPE, Value::Bool(b)) => Answer::Bool(b),
        (NUMBER_TYPE, v) => Answer::Number(eval.to_num(&v)),
        (STRING_TYPE, v) => Answer::Str(eval.to_str(&v)),
        (BOOLEAN_TYPE, v) => Answer::Bool(eval.to_bool(&v)),
        (_, Value::Nodes(mut ns)) => {
            eval.ordered(&mut ns);
            Answer::Nodes(ns.nodes)
        }
        _ => return type_err("the result cannot be converted to the requested node-set type"),
    })
}

// The attribute of element `owner` stored under `key`, as an XPath node.
pub(crate) fn attribute_node(arena: &RealmArena, owner: NodeId, key: &str) -> Option<XNode> {
    let n = arena.get(owner)?;
    n.attributes.iter().position(|(k, _)| k == key).map(|i| XNode::Attr(owner, i as u32))
}

// The store key of an attribute node.
pub(crate) fn attribute_key(arena: &RealmArena, owner: NodeId, index: u32) -> Option<&str> {
    arena.get(owner)?.attributes.get(index as usize).map(|(k, _)| k.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexes_operator_names_before_parens() {
        assert!(parse(&utf16("(a = 'x') or (b = 'y')")).is_ok());
        assert!(parse(&utf16("div div div")).is_ok());
        assert!(matches!(parse(&utf16("$x")), Err(XError::Syntax(_))));
        assert!(matches!(parse(&utf16("//*[")), Err(XError::Syntax(_))));
        // (…an unknown function, or a known one called with the wrong number of arguments, is no expression)
        assert!(matches!(parse(&utf16("foo()")), Err(XError::Syntax(_))));
        assert!(matches!(parse(&utf16("concat('a')")), Err(XError::Syntax(_))));
        assert!(matches!(parse(&utf16("p:f(1)")), Err(XError::Syntax(_))));
        assert!(parse(&utf16("concat('a', 'b', 'c')")).is_ok());
    }

    #[test]
    fn fuses_descendant_steps_unless_positional() {
        let Ok(Expr::Path(_, steps)) = parse(&utf16("//a[@href]")) else { panic!() };
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].axis, Axis::Descendant);
        let Ok(Expr::Path(_, steps)) = parse(&utf16("//a[1]")) else { panic!() };
        assert_eq!(steps.len(), 2);
    }

    #[test]
    fn keeps_a_lone_surrogate_in_a_literal() {
        let units = [b'"' as u16, 0xD800, b'x' as u16, b'"' as u16];
        let Ok(Expr::Literal(l)) = parse(&units) else { panic!() };
        assert_eq!(l, vec![0xD800, b'x' as u16]);
    }

    #[test]
    fn converts_numbers_and_strings() {
        assert_eq!(number_to_string(1.0), "1");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(1e21), "1000000000000000000000");
        assert_eq!(number_to_string(0.5), "0.5");
        assert_eq!(str_to_number(&utf16(" -1.5 ")), -1.5);
        assert!(str_to_number(&utf16("1e3")).is_nan());
        assert!(str_to_number(&utf16(".")).is_nan());
        assert_eq!(str_to_number(&utf16(".5")), 0.5);
        assert_eq!(normalize_space(&utf16("  a \n b  ")), utf16("a b"));
        assert!(xpath_round(-0.5) == 0.0 && xpath_round(-0.5).is_sign_negative());
        assert!(xpath_round(-0.0).is_sign_negative() && xpath_round(0.2).is_sign_positive());
        assert_eq!(xpath_round(2.5), 3.0);
    }

    #[test]
    fn collects_prefixes() {
        let (e, p) = match &*parsed(&utf16("//svg:rect[@xlink:href]/xml:x")) {
            Ok(x) => x.clone(),
            Err(m) => panic!("{m}"),
        };
        let _ = e;
        assert_eq!(p, vec!["svg".to_string(), "xlink".to_string()]);
    }
}
