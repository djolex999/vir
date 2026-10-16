from collections.abc import Callable

Rng = Callable[[], float]

_MASK = 0xFFFFFFFF


def make_rng(seed: int) -> Rng:
    """mulberry32, bit-for-bit identical to eval/rng.ts makeRng.

    JS mixes int32 and uint32 views of the same bits; every operation here is
    taken mod 2^32 with logical shifts, which yields the same bits.
    """
    state = seed & _MASK

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _MASK
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
        t = (t ^ (t + (((t ^ (t >> 7)) * (t | 61)) & _MASK))) & _MASK
        return ((t ^ (t >> 14)) & _MASK) / 4294967296

    return next_float
