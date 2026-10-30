#!/usr/bin/env bash
# Produce a Windows ISO that boots the CD without the "Press any key to boot
# from CD or DVD" countdown.
#
# Why this exists: the consumer ISO's El Torito catalog points its EFI entry at
# a *hidden* boot image (LBA 536) whose bootloader waits ~5 s for a keystroke
# before falling through. Under a headless hypervisor that keystroke is not
# deliverable — `virsh send-key`, QMP `input-send-event` and HMP `sendkey` all
# fail to reach the firmware — so an unattended install never starts.
#
# Microsoft already ships the fix inside the ISO: efi/microsoft/boot/
# efisys_noprompt.bin is the same FAT12 ESP image with the prompt removed. The
# two images are byte-for-byte the same length, so the catalog can simply be
# re-aimed at the noprompt image's LBA. That is a 4-byte edit; nothing else in
# the ISO changes and the original file is never modified.
#
# Usage: make-noprompt-iso.sh <source-iso> <output-iso>
# Idempotent: an output that already carries the patched LBA is left alone.
set -euo pipefail

SRC=${1:?source ISO required}
DST=${2:?destination ISO required}

if [[ ! -e $DST ]]; then
  echo "copying $(basename "$SRC") -> $(basename "$DST") (full ISO, no reflink on ext4)"
  cp --reflink=auto "$SRC" "$DST"
fi

python3 - "$SRC" "$DST" <<'PY'
import os, struct, sys

src, dst = sys.argv[1], sys.argv[2]
SECTOR = 2048
# El Torito catalog of the consumer ISO lives at LBA 22; the EFI initial entry
# starts at byte offset 96 of that sector and its image-LBA field sits at +8.
CAT_LBA, EFI_ENTRY_OFF, LBA_FIELD = 22, 96, 8
HIDDEN_PROMPT_LBA = 536          # efisys.bin, stored outside the file tree
IMAGE_BYTES = 1474560            # both efisys images: 720 sectors


def find_esp_images(path, key):
    """All sector-aligned offsets where the shared FAT12 ESP header starts.

    The two efisys images open with an identical BIOS parameter block, so the
    only honest way to tell them apart is to collect every ESP image in the
    image and compare their full boot sectors afterwards. Searching by the
    prompt image's own bytes can only ever find prompt copies.
    """
    fd = os.open(path, os.O_RDONLY)
    size = os.fstat(fd).st_size
    pos, carry, hits = 0, b"", []
    try:
        while pos < size:
            os.lseek(fd, pos, os.SEEK_SET)
            block = os.read(fd, 64 << 20)
            if not block:
                break
            data, base = carry + block, pos - len(carry)
            s = 0
            while True:
                i = data.find(key, s)
                if i < 0:
                    break
                abs_off = base + i
                if abs_off >= 0 and abs_off % SECTOR == 0:
                    hits.append(abs_off // SECTOR)
                s = i + 1
            carry = block[-len(key):]
            pos += len(block)
    finally:
        os.close(fd)
    return hits


def head_of(fd, lba):
    os.lseek(fd, lba * SECTOR, os.SEEK_SET)
    return os.read(fd, SECTOR)


ro = os.open(src, os.O_RDONLY)
try:
    cat = head_of(ro, CAT_LBA)
    entry = cat[EFI_ENTRY_OFF:EFI_ENTRY_OFF + 32]
    if entry[0] != 0x88:
        sys.exit(f"unexpected catalog: no bootable entry at LBA {CAT_LBA}+{EFI_ENTRY_OFF}")
    cur_lba, sectors = struct.unpack("<II", entry[LBA_FIELD:LBA_FIELD + 8])
    print(f"current EFI entry -> LBA {cur_lba} ({sectors} sectors recorded)")

    prompt_head = head_of(ro, HIDDEN_PROMPT_LBA)
    if b"EFISECTOR" not in prompt_head[40:64]:
        sys.exit(f"LBA {HIDDEN_PROMPT_LBA} is not the hidden efisys image; ISO layout differs, aborting")

    # Collect every ESP image, then classify by the whole boot sector.
    images = [l for l in find_esp_images(src, prompt_head[:11])
              if b"EFISECTOR" in head_of(ro, l)[40:64]]
    if cur_lba not in images:
        sys.exit(f"catalog LBA {cur_lba} not among ESP images {images}")

    differing, seen = [], set()
    for lba in images:
        if lba == cur_lba:
            continue
        h = head_of(ro, lba)
        if h == prompt_head:
            continue  # another byte-identical prompt copy
        if h in seen:
            continue
        seen.add(h)
        differing.append((lba, h))

    if not differing:
        sys.exit(f"no image differs from the prompt image among {images}")
    if len(differing) > 1:
        sys.exit(f"ambiguous: {len(differing)} distinct non-prompt ESP images "
                 f"at {[l for l, _ in differing]}")

    target, target_head = differing[0]
    # Only the geometry has to match: it decides how many sectors the firmware
    # reads from the new LBA, and a mismatch would need the catalog length
    # patched too. The volume serial (BPB offset 39..42) legitimately differs
    # between two builds of the same image, so it is excluded on purpose.
    if prompt_head[11:39] != target_head[11:39]:
        d = [i for i in range(11, 39) if prompt_head[i] != target_head[i]]
        sys.exit(f"image at LBA {target} has a different FAT geometry "
                 f"(BPB bytes {d}); refusing to swap")
    if b"EFISECTOR" not in target_head[40:64]:
        sys.exit(f"image at LBA {target} is not labelled EFISECTOR")
    ndiff = sum(1 for i in range(2048) if prompt_head[i] != target_head[i])
    print(f"noprompt image at LBA {target}: geometry identical, "
          f"{ndiff} boot-sector byte(s) differ (volume serial)")
finally:
    os.close(ro)

# Apply.
fd = os.open(dst, os.O_RDWR)
try:
    os.lseek(fd, CAT_LBA * SECTOR + EFI_ENTRY_OFF + LBA_FIELD, os.SEEK_SET)
    now = struct.unpack("<I", os.read(fd, 4))[0]
    if now == target:
        print(f"already patched (LBA {now}); leaving {dst} alone")
    else:
        os.lseek(fd, CAT_LBA * SECTOR + EFI_ENTRY_OFF + LBA_FIELD, os.SEEK_SET)
        os.write(fd, struct.pack("<I", target))
        os.fsync(fd)
        print(f"patched {dst}: EFI image LBA {now} -> {target}")
finally:
    os.close(fd)
PY

echo "listo: $DST"
