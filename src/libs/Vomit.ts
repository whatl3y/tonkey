import columnify from "columnify";
import { IStringMap } from "../types";

const NOOP = () => {};

export default {
  singleLine(str: string, numWrappedRows = 1) {
    this.wrapInNewlines(() => console.log(str), numWrappedRows);
  },

  success(str: string, twoLineWrap = true) {
    let wrapper = (foo: any) => foo();
    if (twoLineWrap) wrapper = this.wrapInNewlines;
    wrapper(() => console.log(str));
  },

  error(something: any) {
    this.wrapInNewlines(() => console.log(something));
  },

  wrapInNewlines(functionToWriteMoreOutput = NOOP, howMany = 1) {
    const newlineString =
      howMany - 1 > 0 ? new Array(howMany - 1).fill("\n").join("") : "";
    if (howMany > 0) console.log(newlineString);
    functionToWriteMoreOutput();
    if (howMany > 0) console.log(newlineString);
  },

  table(data: IStringMap[]) {
    return console.log(
      columnify(data, {
        minWidth: 15,
      }),
    );
  },
};
