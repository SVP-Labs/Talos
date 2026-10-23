//! Code over every limit.

pub mod long;

/// Reads a number, panicking on anything else.
#[must_use]
pub fn number(text: &str) -> u32 {
    text.parse::<u32>().unwrap()
}

/// Too many inputs.
#[must_use]
pub fn sum(a: u32, b: u32, c: u32, d: u32, e: u32) -> u32 {
    a + b + c + d + e
}

/// Nested too deep.
#[must_use]
pub fn deep(items: &[u32]) -> u32 {
    let mut total = 0;
    for item in items {
        if *item > 1 {
            if *item > 2 {
                while total < *item {
                    total += 1;
                }
            }
        }
    }
    total
}

/// Reads memory it was handed.
#[allow(unsafe_code)]
#[must_use]
pub fn read(value: &u32) -> u32 {
    let pointer: *const u32 = value;
    // SAFETY: the pointer comes from a reference.
    unsafe { *pointer }
}

/// Far too long.
#[must_use]
pub fn long_one(seed: u32) -> u32 {
    let mut n = seed;
    n = n.wrapping_mul(31).wrapping_add(0);
    n = n.wrapping_mul(31).wrapping_add(1);
    n = n.wrapping_mul(31).wrapping_add(2);
    n = n.wrapping_mul(31).wrapping_add(3);
    n = n.wrapping_mul(31).wrapping_add(4);
    n = n.wrapping_mul(31).wrapping_add(5);
    n = n.wrapping_mul(31).wrapping_add(6);
    n = n.wrapping_mul(31).wrapping_add(7);
    n = n.wrapping_mul(31).wrapping_add(8);
    n = n.wrapping_mul(31).wrapping_add(9);
    n = n.wrapping_mul(31).wrapping_add(10);
    n = n.wrapping_mul(31).wrapping_add(11);
    n = n.wrapping_mul(31).wrapping_add(12);
    n = n.wrapping_mul(31).wrapping_add(13);
    n = n.wrapping_mul(31).wrapping_add(14);
    n = n.wrapping_mul(31).wrapping_add(15);
    n = n.wrapping_mul(31).wrapping_add(16);
    n = n.wrapping_mul(31).wrapping_add(17);
    n = n.wrapping_mul(31).wrapping_add(18);
    n = n.wrapping_mul(31).wrapping_add(19);
    n = n.wrapping_mul(31).wrapping_add(20);
    n = n.wrapping_mul(31).wrapping_add(21);
    n = n.wrapping_mul(31).wrapping_add(22);
    n = n.wrapping_mul(31).wrapping_add(23);
    n = n.wrapping_mul(31).wrapping_add(24);
    n = n.wrapping_mul(31).wrapping_add(25);
    n = n.wrapping_mul(31).wrapping_add(26);
    n = n.wrapping_mul(31).wrapping_add(27);
    n = n.wrapping_mul(31).wrapping_add(28);
    n = n.wrapping_mul(31).wrapping_add(29);
    n = n.wrapping_mul(31).wrapping_add(30);
    n = n.wrapping_mul(31).wrapping_add(31);
    n = n.wrapping_mul(31).wrapping_add(32);
    n = n.wrapping_mul(31).wrapping_add(33);
    n = n.wrapping_mul(31).wrapping_add(34);
    n = n.wrapping_mul(31).wrapping_add(35);
    n = n.wrapping_mul(31).wrapping_add(36);
    n = n.wrapping_mul(31).wrapping_add(37);
    n = n.wrapping_mul(31).wrapping_add(38);
    n = n.wrapping_mul(31).wrapping_add(39);
    n = n.wrapping_mul(31).wrapping_add(40);
    n = n.wrapping_mul(31).wrapping_add(41);
    n = n.wrapping_mul(31).wrapping_add(42);
    n = n.wrapping_mul(31).wrapping_add(43);
    n = n.wrapping_mul(31).wrapping_add(44);
    n = n.wrapping_mul(31).wrapping_add(45);
    n = n.wrapping_mul(31).wrapping_add(46);
    n = n.wrapping_mul(31).wrapping_add(47);
    n = n.wrapping_mul(31).wrapping_add(48);
    n = n.wrapping_mul(31).wrapping_add(49);
    n = n.wrapping_mul(31).wrapping_add(50);
    n = n.wrapping_mul(31).wrapping_add(51);
    n = n.wrapping_mul(31).wrapping_add(52);
    n = n.wrapping_mul(31).wrapping_add(53);
    n = n.wrapping_mul(31).wrapping_add(54);
    n = n.wrapping_mul(31).wrapping_add(55);
    n = n.wrapping_mul(31).wrapping_add(56);
    n = n.wrapping_mul(31).wrapping_add(57);
    n = n.wrapping_mul(31).wrapping_add(58);
    n = n.wrapping_mul(31).wrapping_add(59);
    n = n.wrapping_mul(31).wrapping_add(60);
    n = n.wrapping_mul(31).wrapping_add(61);
    n
}
