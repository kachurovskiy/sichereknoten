import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";

const codecModule = loadCodecModule();

test("accident records binary codec round-trips representative records", async () => {
  const { encodeAccidentRecordsBinary, decodeAccidentRecordsBinary } = await codecModule;
  const records = sampleAccidentRecords();
  const decoded = decodeAccidentRecordsBinary(encodeAccidentRecordsBinary(records));

  assert.deepEqual(decoded, records);
});

test("accident records binary decoder rejects invalid headers", async () => {
  const { decodeAccidentRecordsBinary } = await codecModule;

  assert.throws(() => decodeAccidentRecordsBinary(new TextEncoder().encode("not-binary")), /invalid header/i);
});

test("accident records binary decoder rejects trailing bytes", async () => {
  const { encodeAccidentRecordsBinary, decodeAccidentRecordsBinary } = await codecModule;
  const encoded = encodeAccidentRecordsBinary(sampleAccidentRecords());
  const withTrailingByte = new Uint8Array(encoded.byteLength + 1);
  withTrailingByte.set(encoded);

  assert.throws(() => decodeAccidentRecordsBinary(withTrailingByte), /trailing bytes/i);
});

async function loadCodecModule() {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/data/accidentRecordsBinary.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    legalComments: "none"
  });
  const code = result.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return import(moduleUrl);
}

function sampleAccidentRecords() {
  return [
    {
      id: "accident-1",
      recordIndex: 7,
      serialNumber: "SER-1",
      source: "Unfallorte2025.csv",
      sourceType: "csv",
      streetName: "Koenigsallee",
      streetNames: ["Koenigsallee", "Steinstrasse"],
      osmRoundabout: true,
      osmRoundaboutId: 12,
      osmRoundaboutLon: 7.1234567,
      osmRoundaboutLat: 50.9876543,
      osmRoundaboutRadiusMeters: 18,
      osmRoundaboutMatchRadiusMeters: 38,
      osmTrafficSignal: true,
      stateCode: "05",
      stateName: "Nordrhein-Westfalen",
      administrativeRegionCode: "051",
      administrativeRegionName: "Duesseldorf",
      districtCode: "05111",
      districtName: "Duesseldorf, Stadt",
      municipalityCode: "05111000",
      municipalityName: "Duesseldorf",
      year: 2025,
      month: 4,
      day: 16,
      hour: 9,
      weekday: 4,
      category: 2,
      accidentKind: 5,
      accidentType: 3,
      lightCondition: 1,
      roadSurface: 0,
      plausibilityLevel: 2,
      linRefX: 323456.75,
      linRefY: 5678901.25,
      lon: 7.123456789,
      lat: 50.987654321,
      involvesBike: true,
      involvesPedestrian: false,
      involvesMotorcycle: null,
      involvesCar: true,
      involvesTruck: false,
      involvesOther: null
    },
    {
      id: "accident-2",
      serialNumber: null,
      source: "Unfallorte2025.dbf",
      sourceType: "dbf",
      streetName: null,
      streetNames: [],
      osmRoundabout: null,
      osmRoundaboutId: null,
      osmRoundaboutLon: null,
      osmRoundaboutLat: null,
      osmRoundaboutRadiusMeters: null,
      osmRoundaboutMatchRadiusMeters: null,
      osmTrafficSignal: null,
      stateCode: "11",
      stateName: "Berlin",
      administrativeRegionCode: null,
      administrativeRegionName: null,
      districtCode: null,
      districtName: null,
      municipalityCode: null,
      municipalityName: null,
      year: 2024,
      month: null,
      day: null,
      hour: null,
      weekday: null,
      category: null,
      accidentKind: null,
      accidentType: null,
      lightCondition: null,
      roadSurface: null,
      plausibilityLevel: null,
      linRefX: null,
      linRefY: null,
      lon: 13.5,
      lat: 52.5,
      involvesBike: null,
      involvesPedestrian: true,
      involvesMotorcycle: false,
      involvesCar: null,
      involvesTruck: true,
      involvesOther: false
    }
  ];
}
