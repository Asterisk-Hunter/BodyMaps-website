import { expect, it } from "vitest";
import { parseAnnotationCaseCsv } from "./annotationCaseCsv";

it("imports a header and quoted case identifiers", () => {
  expect(parseAnnotationCaseCsv('\uFEFFcase_id\r\n"PanTS_00000055"\r\n56\r\n')).toEqual(["PanTS_00000055", "56"]);
});

it("rejects multiple columns and broken quotes", () => {
  expect(() => parseAnnotationCaseCsv("case_id,name\n55,case")).toThrow();
  expect(() => parseAnnotationCaseCsv('"55')).toThrow();
});
