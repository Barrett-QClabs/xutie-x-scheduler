import { beforeEach } from "vitest";
import { resetAllData } from "@/lib/db";
import { resetMockXClient } from "@/lib/x-client";

beforeEach(() => {
  resetAllData();
  resetMockXClient();
});
