/** Shared by the actual inline browser script and its draft regression tests. */
export const permissionModelSource = String.raw`
const model = {
  clone(value) { return JSON.parse(JSON.stringify(value)); },
  replaceGrant(grants, id, edit) { return grants.map(grant => this.clone(grant.id === id ? edit : grant)); },
  removeGrant(grants, id) { return grants.filter(grant => grant.id !== id).map(grant => this.clone(grant)); },
  stable(value) {
    if (Array.isArray(value)) return value.map(item => this.stable(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, this.stable(value[key])]));
    return value;
  },
  changed(before, after) { return JSON.stringify(this.stable(before)) !== JSON.stringify(this.stable(after)); }
};`;
