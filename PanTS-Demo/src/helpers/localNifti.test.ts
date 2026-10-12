import { afterEach, expect, it, vi } from "vitest";
import { clearLocalNiftiFile, loadLocalNiftiAsRawBlobUrl, setLocalNiftiFile } from "./localNifti";

afterEach(() => { clearLocalNiftiFile(); vi.restoreAllMocks(); });

it("does not publish an old local scan after an account change clears its cache mid-read", async () => {
  let finish!: (value: ArrayBuffer) => void;
  const file = new File(["private-scan"], "scan.nii");
  Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) });
  URL.createObjectURL = vi.fn(() => "blob:private");
  setLocalNiftiFile(file);
  const loading = loadLocalNiftiAsRawBlobUrl();
  clearLocalNiftiFile();
  finish(new ArrayBuffer(16));
  expect(await loading).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
