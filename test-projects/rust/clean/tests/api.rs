//! The crate from outside.

#[test]
fn counts_from_outside() {
    assert_eq!(tally::words("a b"), 2);
}
