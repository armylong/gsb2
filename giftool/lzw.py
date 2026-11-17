"""GIF LZW (variable-width code) decoder and encoder.

GIF image data uses LZW with a variable code width, wrapped in length-prefixed
sub-blocks (a sub-block is one length byte followed by that many data bytes;
a zero byte terminates the stream).  The code width starts at
``min_code_size + 1`` and grows up to 12 bits; codes 2**min_code_size and
2**min_code_size + 1 are reserved for CLEAR and END_OF_INFORMATION.

Both directions are implemented from scratch here so that the rest of the
tool does not depend on a particular Pillow version's GIF internals.
"""

from __future__ import annotations

from collections.abc import Iterable

# GIF hard limits: code width never exceeds 12 bits.
MAX_CODE_SIZE = 12
MAX_CODES = 1 << MAX_CODE_SIZE  # 4096


class LzwError(ValueError):
    """Raised when a GIF LZW stream is malformed."""


def decode(sub_blocks: Iterable[bytes], min_code_size: int) -> list[int]:
    """Decode GIF LZW sub-blocks into a flat list of palette indices."""
    if not 2 <= min_code_size <= 8:
        msg = f"invalid LZW minimum code size: {min_code_size}"
        raise LzwError(msg)

    clear_code = 1 << min_code_size
    eoi_code = clear_code + 1

    def init_table() -> tuple[list[list[int]], int, int]:
        table: list[list[int]] = [[i] for i in range(clear_code)]
        table.append([])  # CLEAR
        table.append([])  # EOI
        return table, min_code_size + 1, clear_code + 2

    table, code_size, next_code = init_table()
    output: list[int] = []

    # Single little-endian bit reservoir.  Codes are consumed LSB-first; the
    # reservoir only ever holds whole bytes not yet fully consumed, so a
    # mid-stream code-width change applies cleanly to the next code.
    reservoir = 0
    reservoir_bits = 0
    byte_iter = (byte for block in sub_blocks for byte in block)

    def next_code_value() -> int:
        nonlocal reservoir, reservoir_bits
        while reservoir_bits < code_size:
            try:
                reservoir |= next(byte_iter) << reservoir_bits
            except StopIteration:
                msg = "LZW stream ended in the middle of a code"
                raise LzwError(msg) from None
            reservoir_bits += 8
        value = reservoir & ((1 << code_size) - 1)
        reservoir >>= code_size
        reservoir_bits -= code_size
        return value

    previous: list[int] | None = None
    started = False

    while True:
        code = next_code_value()

        if code == clear_code:
            table, code_size, next_code = init_table()
            previous = None
            started = False
            continue
        if code == eoi_code:
            return output

        if not started:
            # First code after a CLEAR must be a literal (< clear_code).
            if code >= clear_code:
                msg = "first LZW code after CLEAR is not a literal"
                raise LzwError(msg)
            output.extend(table[code])
            previous = table[code]
            started = True
            continue

        if code < len(table):
            entry = table[code]
        elif code == next_code and previous is not None:
            # The classic "KwKwK" special case.
            entry = [*previous, previous[0]]
        else:
            msg = f"LZW code {code} out of range (next {next_code})"
            raise LzwError(msg)

        output.extend(entry)
        if next_code < MAX_CODES:
            table.append([*(previous or []), entry[0]])
            next_code += 1
            # Decoder-side width rule.  The encoder widens one insertion
            # earlier in its own counting (after the entry that lands on
            # 2**code_size + 1) because it must emit the *next* code at the
            # new width; from the decoder's perspective that same transition
            # is observed here once next_code reaches 2**code_size, and the
            # following get_code_value() then reads at the wider width.  The
            # two conditions describe one physical boundary and are matched
            # by Pillow/giflib decoders.
            if next_code == (1 << code_size) and code_size < MAX_CODE_SIZE:
                code_size += 1
        previous = entry


def encode(indices: bytes | bytearray | list[int], min_code_size: int) -> bytes:
    """Encode palette indices into GIF sub-block wrapped LZW data.

    The returned bytes include the leading minimum-code-size byte, the data
    sub-blocks and the terminating zero block, exactly as stored after a GIF
    image descriptor.
    """
    if not 2 <= min_code_size <= 8:
        msg = f"invalid LZW minimum code size: {min_code_size}"
        raise LzwError(msg)

    clear_code = 1 << min_code_size
    eoi_code = clear_code + 1

    def new_table() -> dict[bytes, int]:
        return {bytes([i]): i for i in range(clear_code)}

    table = new_table()
    code_size = min_code_size + 1
    next_code = clear_code + 2

    packed = bytearray()
    bit_buffer = 0
    bit_count = 0

    def emit(code: int) -> None:
        nonlocal bit_buffer, bit_count
        bit_buffer |= code << bit_count
        bit_count += code_size
        while bit_count >= 8:
            packed.append(bit_buffer & 0xFF)
            bit_buffer >>= 8
            bit_count -= 8

    emit(clear_code)

    current = b""
    for value in indices:
        candidate = current + bytes([value])
        if candidate in table:
            current = candidate
            continue

        emit(table[current])
        if next_code < MAX_CODES:
            table[candidate] = next_code
            next_code += 1
            # Match the decoder's width rule exactly: widen only after the
            # table already holds 2**code_size entries, so the entry at index
            # 2**code_size is still emitted at the old width.
            if next_code == (1 << code_size) + 1 and code_size < MAX_CODE_SIZE:
                code_size += 1
            current = bytes([value])
        else:
            # Table full (all 4096 codes in use): emit CLEAR at the current
            # (12-bit) width, reset table and width, then re-learn the
            # candidate that did not fit.  The decoder performs the identical
            # reset when it reads this CLEAR.
            emit(clear_code)
            table = new_table()
            code_size = min_code_size + 1
            next_code = clear_code + 2
            # Re-seed with the last emitted prefix's first symbol so the
            # candidate can be learned afresh in the new table.
            current = bytes([value])

    if current:
        emit(table[current])
    emit(eoi_code)
    if bit_count:
        packed.append(bit_buffer & 0xFF)

    # Wrap into sub-blocks of at most 255 bytes.
    out = bytearray([min_code_size])
    for start in range(0, len(packed), 255):
        chunk = bytes(packed[start : start + 255])
        out.append(len(chunk))
        out.extend(chunk)
    out.append(0)  # block terminator
    return bytes(out)
