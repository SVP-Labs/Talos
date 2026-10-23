//! Prints a greeting.

fn main() {
    println!("{}", greeting());
}

fn greeting() -> &'static str {
    "hello"
}

fn farewell() -> &'static str {
    "goodbye"
}
