"""Minimal PDF text extraction — enough to assert on generated document content.

Not a general PDF parser: it inflates each Flate-encoded content stream and
pulls the strings out of the text-showing operators, which is all reportlab
emits for these documents.
"""
import base64
import re
import sys
import zlib


def extract(path: str) -> str:
    raw = open(path, "rb").read()
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", raw, re.S):
        chunk = m.group(1)
        # reportlab writes /ASCII85Decode then /FlateDecode by default, so the
        # bytes must be un-ascii85'd before they will inflate.
        if b"~>" in chunk:
            try:
                chunk = base64.a85decode(chunk[: chunk.index(b"~>")], adobe=False)
            except ValueError:
                pass
        try:
            chunk = zlib.decompress(chunk)
        except zlib.error:
            pass
        # Tj / TJ operands: (text) Tj  and  [(a) -20 (b)] TJ
        for t in re.finditer(rb"\((?:\\.|[^\\()])*\)", chunk):
            s = t.group(0)[1:-1]
            s = s.replace(rb"\(", b"(").replace(rb"\)", b")").replace(rb"\\", b"\\")
            try:
                out.append(s.decode("utf-8"))
            except UnicodeDecodeError:
                out.append(s.decode("latin-1"))
    return " ".join(out)


if __name__ == "__main__":
    print(extract(sys.argv[1]))
