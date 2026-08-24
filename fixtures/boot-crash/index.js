// dshpkg fixture — intentional boot-time crash: apply() throws on load.
export const name = "boot-crash-fixture";

export function apply(ctx) {
  throw new Error("boot-crash fixture: intentional boot failure");
}
