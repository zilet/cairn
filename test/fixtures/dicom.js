function even(buffer, pad = 0x20) {
  return buffer.length % 2 ? Buffer.concat([buffer, Buffer.from([pad])]) : buffer;
}

function text(vr, value) {
  return even(Buffer.from(String(value), "ascii"), vr === "UI" ? 0 : 0x20);
}

function explicit(group, element, vr, value) {
  const tag = Buffer.alloc(4);
  tag.writeUInt16LE(group, 0);
  tag.writeUInt16LE(element, 2);
  const long = ["OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UR", "UT", "UN"].includes(vr);
  const header = Buffer.alloc(long ? 8 : 4);
  header.write(vr, 0, "ascii");
  if (long) header.writeUInt32LE(value.length, 4);
  else header.writeUInt16LE(value.length, 2);
  return Buffer.concat([tag, header, value]);
}

function us(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

export function minimalDicom(options = {}) {
  const sopClass = options.sopClass ?? "1.2.840.10008.5.1.4.1.1.2";
  const sop = options.sop ?? "1.2.826.0.1.3680043.10.543.1";
  const study = options.study ?? "1.2.826.0.1.3680043.10.543.2";
  const series = options.series ?? "1.2.826.0.1.3680043.10.543.3";
  const ts = options.transferSyntax ?? "1.2.840.10008.1.2.1";
  const bits = options.bitsAllocated ?? 8;
  const rows = options.rows ?? 1;
  const columns = options.columns ?? 3;
  const frames = options.frames ?? 1;
  const pixels = options.pixels ?? (bits === 8 ? [0, 127, 255] : [0xffff, 0, 0x7fff]);
  const pixelBytes = Buffer.alloc(pixels.length * (bits / 8));
  pixels.forEach((value, index) =>
    bits === 8 ? pixelBytes.writeUInt8(value, index) : pixelBytes.writeUInt16LE(value, index * 2)
  );
  const metaTail = Buffer.concat([
    explicit(0x0002, 0x0001, "OB", Buffer.from([0, 1])),
    explicit(0x0002, 0x0002, "UI", text("UI", sopClass)),
    explicit(0x0002, 0x0003, "UI", text("UI", sop)),
    explicit(0x0002, 0x0010, "UI", text("UI", ts)),
    explicit(0x0002, 0x0012, "UI", text("UI", "1.2.826.0.1.3680043.10.543.99")),
  ]);
  const groupLength = Buffer.alloc(4);
  groupLength.writeUInt32LE(metaTail.length);
  const dataset = [
    explicit(0x0008, 0x0016, "UI", text("UI", sopClass)),
    explicit(0x0008, 0x0018, "UI", text("UI", sop)),
    explicit(0x0008, 0x0020, "DA", text("DA", options.studyDate ?? "20260719")),
    explicit(0x0008, 0x0060, "CS", text("CS", options.modality ?? "CT")),
    ...(options.patientId === null ? [] : [explicit(0x0010, 0x0020, "LO", text("LO", options.patientId ?? "TEST"))]),
    explicit(0x0018, 0x0015, "CS", text("CS", options.bodyPart ?? "CHEST")),
    ...(options.studyDescription ? [explicit(0x0008, 0x1030, "LO", text("LO", options.studyDescription))] : []),
    ...(options.seriesDescription ? [explicit(0x0008, 0x103e, "LO", text("LO", options.seriesDescription))] : []),
    explicit(0x0020, 0x000d, "UI", text("UI", study)),
    explicit(0x0020, 0x000e, "UI", text("UI", series)),
    explicit(0x0020, 0x0011, "IS", text("IS", options.seriesNumber ?? 1)),
    explicit(0x0020, 0x0013, "IS", text("IS", options.instanceNumber ?? 1)),
    ...(options.imagePosition ? [explicit(0x0020, 0x0032, "DS", text("DS", options.imagePosition))] : []),
    ...(options.imageOrientation ? [explicit(0x0020, 0x0037, "DS", text("DS", options.imageOrientation))] : []),
    ...(options.frameOfReference ? [explicit(0x0020, 0x0052, "UI", text("UI", options.frameOfReference))] : []),
    ...(options.laterality ? [explicit(0x0020, 0x0062, "CS", text("CS", options.laterality))] : []),
    explicit(0x0028, 0x0002, "US", us(1)),
    explicit(0x0028, 0x0004, "CS", text("CS", options.photometric ?? "MONOCHROME2")),
    ...(frames > 1 ? [explicit(0x0028, 0x0008, "IS", text("IS", frames))] : []),
    explicit(0x0028, 0x0010, "US", us(rows)),
    explicit(0x0028, 0x0011, "US", us(columns)),
    explicit(0x0028, 0x0100, "US", us(bits)),
    explicit(0x0028, 0x0101, "US", us(options.bitsStored ?? bits)),
    explicit(0x0028, 0x0102, "US", us(options.highBit ?? bits - 1)),
    explicit(0x0028, 0x0103, "US", us(options.signed ? 1 : 0)),
    explicit(0x0028, 0x1052, "DS", text("DS", options.intercept ?? 0)),
    explicit(0x0028, 0x1053, "DS", text("DS", options.slope ?? 1)),
    explicit(0x0028, 0x1050, "DS", text("DS", options.windowCenter ?? 100)),
    explicit(0x0028, 0x1051, "DS", text("DS", options.windowWidth ?? 200)),
    explicit(0x7fe0, 0x0010, bits === 8 ? "OB" : "OW", even(pixelBytes, 0)),
  ];
  return Buffer.concat([
    Buffer.alloc(128),
    Buffer.from("DICM", "ascii"),
    explicit(0x0002, 0x0000, "UL", groupLength),
    metaTail,
    ...dataset,
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
