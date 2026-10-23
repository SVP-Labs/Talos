//! Lenient settings.

/// Reads a number, panicking on anything else.
///
/// # Panics
///
/// When `text` isn't a number.
#[must_use]
pub fn number(text: &str) -> u32 {
    text.parse::<u32>().unwrap()
}
