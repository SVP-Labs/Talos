//! A test that fails.

/// Whether `hour` is at night.
#[must_use]
pub fn is_night(hour: u8) -> bool {
    hour < 6
}

#[cfg(test)]
mod tests {
    use super::is_night;

    #[test]
    fn three_is_night() {
        assert!(is_night(3));
    }

    #[test]
    fn eleven_at_night_is_night() {
        assert!(is_night(23));
    }
}
