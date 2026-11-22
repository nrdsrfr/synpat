"""Byte layout of the decompressed Syntakt project image.

Offsets are identical for project versions 0x0A, 0x0C and 0x0D:
    0          512 B           project header: BEEFBACE, version, name
    512        128 x 23,552 B  patterns (index 0 = A01 ... 127 = H16)
    3,015,168  128 x 5,632 B   kits
Pattern (relative offsets):
    0      u32  pattern structure version
    4      13 tracks x 983 B; each starts with 64 x u16 step flags (bit 0 = trig)
           and ends with 23 B of track settings
    12783  80 parameter-lock slots x 130 B: [param][track][64 x u16], 0xFF = unused
    23183  16 B name
    23201  u16  tempo x 120
    23211  u8   kit index
Kit (relative offsets):
    0      u32  kit structure version
    4      16 B name
    46     12 sounds, each BEEFBACE <u32 version> ... BACEF00C
    then   kit settings block starting with its own u32 version, zero padded
"""

PATTERN_COUNT = 128
PATTERN_BASE = 512
PATTERN_SIZE = 23552
KIT_COUNT = 128
KIT_BASE = PATTERN_BASE + PATTERN_COUNT * PATTERN_SIZE  # 3,015,168
KIT_SIZE = 5632

TRACK_COUNT = 13
TRACK_BASE = 4
TRACK_SIZE = 983
TRACK_SETTINGS = 960  # track-relative start of the 23-byte settings block
STEP_COUNT = 64
LOCK_BASE = TRACK_BASE + TRACK_COUNT * TRACK_SIZE  # 12,783
LOCK_SLOTS = 80
LOCK_SLOT_SIZE = 130
PAT_NAME = 23183
PAT_TEMPO = 23201
PAT_KIT = 23211
NAME_LEN = 16

KIT_NAME = 4
KIT_SOUNDS = 46
SOUNDS_PER_KIT = 12
MAGIC = bytes.fromhex("beefbace")
END_MAGIC = bytes.fromhex("bacef00c")
SOUND_SIZE = {6: 251, 7: 263}

# Structure generations: (pattern version, kit version, sound version).
GEN_A = (9, 9, 6)     # project 0x0A
GEN_B = (11, 11, 7)   # projects 0x0C and 0x0D (same pattern/kit/sound layout)
PROJECT_GENERATIONS = {0x0A: GEN_A, 0x0C: GEN_B, 0x0D: GEN_B}
