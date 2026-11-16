import os
import struct
import tempfile
import unittest

from pcaprecon.capture import read_capture
from pcaprecon.config import Config
from pcaprecon.models import Anomaly
from pcaprecon import samplegen


class PcapNgTests(unittest.TestCase):
    def test_pcapng_roundtrip(self):
        from pcaprecon.analyzer import analyze
        tmp = tempfile.mkdtemp()
        pcap_path = os.path.join(tmp, "in.pcap")
        samplegen.scenario_keepalive(pcap_path)
        ng_path = _convert_to_pcapng(pcap_path, os.path.join(tmp, "in.pcapng"))

        anomalies: list[Anomaly] = []
        records = list(read_capture(ng_path, Config(), anomalies))
        self.assertEqual(anomalies, [])
        self.assertGreaterEqual(len(records), 15)
        result = analyze(ng_path)
        self.assertEqual(len(result.sessions), 1)
        self.assertEqual(len(result.sessions[0].messages), 4)

    def test_big_endian_section(self):
        """H4: IDB/EPB block types must honor the SHB byte order."""
        from pcaprecon.analyzer import analyze
        tmp = tempfile.mkdtemp()
        pcap_path = os.path.join(tmp, "in.pcap")
        samplegen.scenario_keepalive(pcap_path)
        ng_path = _convert_to_pcapng(
            pcap_path, os.path.join(tmp, "be.pcapng"), endian=">")

        anomalies: list[Anomaly] = []
        records = list(read_capture(ng_path, Config(), anomalies))
        self.assertEqual([a.code for a in anomalies], [])
        self.assertGreaterEqual(len(records), 15)
        result = analyze(ng_path)
        self.assertEqual(len(result.sessions), 1)
        self.assertEqual(len(result.sessions[0].messages), 4)

    def test_simple_packet_block_strips_padding(self):
        """M4: SPB block padding must not be decoded as frame bytes."""
        tmp = tempfile.mkdtemp()
        ng_path = os.path.join(tmp, "spb.pcapng")
        frame = b"\x01\x02\x03\x04\x05"  # 5 wire bytes, pads to 8
        out = bytearray()
        out += _block(0x0A0D0D0A,
                      struct.pack("<IHHq", 0x1A2B3C4D, 1, 0, -1))
        out += _block(0x00000001, struct.pack("<HHI", 1, 0, 65535))
        # SPB: original length + frame + 3 padding zeros.
        body = struct.pack("<I", len(frame)) + frame + b"\x00" * 3
        out += _block(0x00000003, body)
        with open(ng_path, "wb") as fh:
            fh.write(out)

        anomalies: list[Anomaly] = []
        records = list(read_capture(ng_path, Config(), anomalies))
        self.assertEqual(len(records), 1)
        _frame_no, _ts, _off, cap_len, orig_len, _lt, data = records[0]
        self.assertEqual(cap_len, 5)
        self.assertEqual(data, frame)
        self.assertNotIn(b"\x00\x00\x00", data)


def _block(btype: int, body: bytes, endian: str = "<") -> bytes:
    total = 12 + len(body)
    return struct.pack(endian + "II", btype, total) + body + \
        struct.pack(endian + "I", total)


def _convert_to_pcapng(src_pcap: str, dst: str,
                       endian: str = "<") -> str:
    """Minimal SHB/IDB/EPB writer used only by the test suite."""
    with open(src_pcap, "rb") as fh:
        global_hdr = fh.read(24)
        linktype = struct.unpack("<I", global_hdr[20:24])[0]
        frames = []
        while True:
            rec = fh.read(16)
            if len(rec) < 16:
                break
            _ts1, _ts2, incl, orig = struct.unpack("<IIII", rec)
            frames.append((incl, orig, fh.read(incl)))

    out = bytearray()
    # SHB: byte-order magic, major/minor version, section length (-1).
    shb_body = struct.pack(endian + "IHHq", 0x1A2B3C4D, 1, 0, -1)
    out += _block(0x0A0D0D0A, shb_body, endian)
    idb_body = struct.pack(endian + "HHI", linktype & 0xFFFF, 0, 65535)
    out += _block(0x00000001, idb_body, endian)
    ts = 0
    for incl, orig, data in frames:
        padded = data + b"\x00" * ((4 - len(data)) % 4)
        epb_body = struct.pack(endian + "IIIII", 0,
                               (ts >> 32), ts & 0xFFFFFFFF,
                               incl, orig) + padded
        out += _block(0x00000006, epb_body, endian)
        ts += 1000
    with open(dst, "wb") as fh:
        fh.write(out)
    return dst


if __name__ == "__main__":
    unittest.main()
