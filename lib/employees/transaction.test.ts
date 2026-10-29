import assert from "node:assert/strict";
import { it } from "node:test";
import { runEmployeeTransaction } from "./transaction";

it("uses a longer timeout for employee management transactions", async () => {
  let receivedTimeout: number | undefined;
  const expectedResult = { completed: true };
  const database = {
    $transaction: async (
      operation: (transaction: never) => Promise<unknown>,
      options: { timeout?: number },
    ) => {
      receivedTimeout = options.timeout;
      return operation({} as never);
    },
  } as never;

  const result = await runEmployeeTransaction(database, async () => expectedResult);

  assert.equal(receivedTimeout, 15_000);
  assert.equal(result, expectedResult);
});
