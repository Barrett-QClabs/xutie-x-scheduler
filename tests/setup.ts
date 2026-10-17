import { beforeEach } from "vitest";
import { resetAllData } from "@/lib/db";

beforeEach(() => {
  resetAllData();
});
