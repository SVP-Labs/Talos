//! A crate that builds only once its setup script has run.

mod generated;

/// Adds the step the setup script wrote.
#[must_use]
pub fn next(n: u32) -> u32 {
    n.saturating_add(generated::STEP)
}
