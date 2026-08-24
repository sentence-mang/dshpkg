// dshpkg fixture — declares an inject of a service nobody provides,
// mimicking "plugin depends on another plugin that is not installed".
export const name = "dep-missing-fixture";

export const inject = ["service.that.does.not.exist"];

export function apply(ctx) {
  // unreachable when injection never resolves
}
