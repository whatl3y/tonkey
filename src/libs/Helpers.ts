import { BigNumber } from "bignumber.js";

type PromiseFunction = (foo?: any) => Promise<any>;

export async function exponentialBackoff(
  promiseFunction: PromiseFunction,
  failureFunction: any = () => {},
  err: null | Error = null,
  totalAllowedBackoffTries: number = 6,
  backoffAttempt: number = 1,
): Promise<any> {
  const backoffSecondsToWait = 2 + Math.pow(backoffAttempt, 2);
  if (backoffAttempt > totalAllowedBackoffTries) throw err;
  try {
    return await promiseFunction();
  } catch (e: any) {
    failureFunction(e, backoffAttempt);
    await sleep(backoffSecondsToWait * 1000);
    return await exponentialBackoff(
      promiseFunction,
      failureFunction,
      e,
      totalAllowedBackoffTries,
      backoffAttempt + 1,
    );
  }
}

export function formatDynamicDecimals(
  number: BigNumber | number | string,
  decimalPadding: number = 1,
): string | number {
  const bnNum = new BigNumber(number);
  if (bnNum.isNaN() || bnNum.lt("0.000000000000000001")) {
    return 0;
  }

  let multiplier = 0.01;
  let decimals = 0;

  while (true) {
    if (
      bnNum
        .times(multiplier)
        .gte(new BigNumber(10).pow(new BigNumber(decimalPadding).minus(1)))
    ) {
      const returnValue = new BigNumber(bnNum).toFixed(decimals);
      if (new BigNumber(bnNum.toFixed(0)).eq(returnValue)) {
        return bnNum.toFormat(0);
      }
      return bnNum.toFormat(decimals);
    }
    decimals++;
    multiplier *= 10;
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function promiseAllConcurrent<T>(
  items: T[],
  worker: (item: T, idx: number) => Promise<any>,
  concurrency = 4,
): Promise<any[]> {
  const results: any[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (cursor < items.length) {
        const my = cursor++;
        results[my] = await worker(items[my], my);
      }
    });
  await Promise.all(runners);
  return results;
}

export function randomizeArray<T>(ary: T[]): T[] {
  return ary
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

export function randomizeObjectKeys(
  obj: Record<string, any>,
  regexp: RegExp,
  randomize?: boolean,
): string[] {
  const filtered = Object.keys(obj).filter((k) => regexp.test(k));
  return randomize ? randomizeArray(filtered) : filtered;
}
