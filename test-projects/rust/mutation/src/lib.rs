//! Limits the tests barely check.

/// Whether `n` is within the limit of ten.
#[must_use]
pub fn within(n: u32) -> bool {
    n <= 10
}

#[cfg(test)]
mod tests {
    use super::within;

    #[test]
    fn small_numbers_are_within() {
        assert!(within(1));
    }
}
