import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeMetaResponsePayload } from "../meta.service.js";

test("raw Meta payload storage redacts access tokens from nested paging URLs", () => {
  const result = sanitizeMetaResponsePayload({
    paging: {
      next: "https://graph.facebook.com/v25.0/id/insights?metric=views&access_token=secret-value&since=1",
    },
    nested: ["Bearer another-secret"],
  });
  assert.equal(
    result.paging.next,
    "https://graph.facebook.com/v25.0/id/insights?metric=views&access_token=[REDACTED]&since=1"
  );
  assert.equal(result.nested[0], "Bearer [REDACTED]");
});
