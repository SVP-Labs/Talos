local messy = {}

function messy.leak()
    leaked = undefined_thing
end

function messy.branches(n)
    if n == 0 then
        return 0
    end
    if n == 1 then
        return 1
    end
    if n == 2 then
        return 2
    end
    if n == 3 then
        return 3
    end
    if n == 4 then
        return 4
    end
    if n == 5 then
        return 5
    end
    if n == 6 then
        return 6
    end
    if n == 7 then
        return 7
    end
    if n == 8 then
        return 8
    end
    if n == 9 then
        return 9
    end
    if n == 10 then
        return 10
    end
    if n == 11 then
        return 11
    end
    if n == 12 then
        return 12
    end
    return -1
end

function messy.deep(a, b, c, d, e)
    if a then
        for i = 1, b do
            while c do
                if c > i then
                    c = c - 1
                end
                if d and e or i then
                    return i
                elseif d then
                    return 0
                else
                    return 1
                end
            end
        end
    end
    return nil
end

function messy.long()
    local total = 0
    total = total + 0
    total = total + 1
    total = total + 2
    total = total + 3
    total = total + 4
    total = total + 5
    total = total + 6
    total = total + 7
    total = total + 8
    total = total + 9
    total = total + 10
    total = total + 11
    total = total + 12
    total = total + 13
    total = total + 14
    total = total + 15
    total = total + 16
    total = total + 17
    total = total + 18
    total = total + 19
    total = total + 20
    total = total + 21
    total = total + 22
    total = total + 23
    total = total + 24
    total = total + 25
    total = total + 26
    total = total + 27
    total = total + 28
    total = total + 29
    total = total + 30
    total = total + 31
    total = total + 32
    total = total + 33
    total = total + 34
    total = total + 35
    total = total + 36
    total = total + 37
    total = total + 38
    total = total + 39
    total = total + 40
    total = total + 41
    total = total + 42
    total = total + 43
    total = total + 44
    total = total + 45
    total = total + 46
    total = total + 47
    total = total + 48
    total = total + 49
    total = total + 50
    total = total + 51
    total = total + 52
    total = total + 53
    total = total + 54
    total = total + 55
    total = total + 56
    total = total + 57
    total = total + 58
    total = total + 59
    total = total + 60
    total = total + 61
    total = total + 62
    total = total + 63
    total = total + 64
    total = total + 65
    total = total + 66
    total = total + 67
    total = total + 68
    total = total + 69
    return total
end

messy.values = {
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    64,
    65,
    66,
    67,
    68,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81,
    82,
    83,
    84,
    85,
    86,
    87,
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    107,
    108,
    109,
    110,
    111,
    112,
    113,
    114,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    123,
    124,
    125,
    126,
    127,
    128,
    129,
    130,
    131,
    132,
    133,
    134,
    135,
    136,
    137,
    138,
    139,
    140,
    141,
    142,
    143,
    144,
    145,
    146,
    147,
    148,
    149,
    150,
    151,
    152,
    153,
    154,
    155,
    156,
    157,
    158,
    159,
    160,
    161,
    162,
    163,
    164,
    165,
    166,
    167,
    168,
    169,
    170,
    171,
    172,
    173,
    174,
    175,
    176,
    177,
    178,
    179,
    180,
    181,
    182,
    183,
    184,
    185,
    186,
    187,
    188,
    189,
    190,
    191,
    192,
    193,
    194,
    195,
    196,
    197,
    198,
    199,
    200,
    201,
    202,
    203,
    204,
    205,
    206,
    207,
    208,
    209,
    210,
    211,
    212,
    213,
    214,
    215,
    216,
    217,
    218,
    219,
    220,
    221,
    222,
    223,
    224,
    225,
    226,
    227,
    228,
    229,
    230,
    231,
    232,
    233,
    234,
    235,
    236,
    237,
    238,
    239,
    240,
    241,
    242,
    243,
    244,
    245,
    246,
    247,
    248,
    249,
    250,
    251,
    252,
    253,
    254,
    255,
    256,
    257,
    258,
    259,
    260,
    261,
    262,
    263,
    264,
    265,
    266,
    267,
    268,
    269,
    270,
    271,
    272,
    273,
    274,
    275,
    276,
    277,
    278,
    279,
    280,
    281,
    282,
    283,
    284,
    285,
    286,
    287,
    288,
    289,
    290,
    291,
    292,
    293,
    294,
    295,
    296,
    297,
    298,
    299,
    300,
    301,
    302,
    303,
    304,
    305,
    306,
    307,
    308,
    309,
    310,
    311,
    312,
    313,
    314,
    315,
    316,
    317,
    318,
    319,
    320,
    321,
    322,
    323,
    324,
    325,
    326,
    327,
    328,
    329,
}

return messy
