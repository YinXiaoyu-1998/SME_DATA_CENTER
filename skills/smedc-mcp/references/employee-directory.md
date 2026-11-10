# Employee And Business Directories

Use this reference when the connected, approved launcher and matching service expose
`query_employee_directory` and `manage_employee_directory`. Both tools use an explicit
`enterpriseKey` from the authenticated organization's enterprise directory. The service derives
the organization from the authenticated account. An employee UID identifies a directory record.
SMEDC user account IDs identify login and authorization subjects.

| Goal                                                                    | Tool and action                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read active stores and departments                                      | `query_employee_directory { request: { action: "list_directory", enterpriseKey }`                                                                      |
| Read pending, historical or retired directory items as an administrator | Use `list_directory` with `management: true`                                                                                                           |
| List readable employee records                                          | `query_employee_directory { request: { action: "list_employees", enterpriseKey }`                                                                      |
| Read one employee record                                                | `query_employee_directory { request: { action: "get_employee", enterpriseKey, employeeUid }`                                                           |
| Add a record                                                            | `manage_employee_directory { request: { action: "create_employee", enterpriseKey, name, departmentId, scope }`                                         |
| Edit, mark departed or restore                                          | `manage_employee_directory { request: { action: "update_employee", enterpriseKey, employeeUid, expectedVersion, name, departmentId, scope, status } }` |
| Manage a store or department                                            | Use `manage_store` or `manage_department` with `enterpriseKey` and the matching `operation`                                                            |

The employee scope is `{ ownership: "group", storeId: null }` for a group employee or
`{ ownership: "store", storeId }` for an employee assigned to a store. Read the directory for
current identifiers before writing. A manager who lacks employee read authority can still create a
record within the manager's enterprise and receives the new employee UID. Editing an existing
record requires both management and business read authority; reassignment also requires authority
for the new scope. Employee status uses `active` or `departed`. Departing employees retain their
record and original assignment. SMEDC account access is managed separately.

Employee listing defaults to `active`. Optional filters include name search, department ID,
store ID and status. Reuse a returned cursor only with the same enterprise and filters. The
access indicator describes the readable scope; an empty list with no access is not a headcount.

Store management operations are `create`, `rename`, `confirm`, `historical`, `retire` and
`restore`. Department operations are `create`, `rename`, `retire` and `restore`. Existing
items use their returned ID and `version` as `expectedVersion`. On conflict, reread the record
and compare changes before retrying. Retirement of a store or department with active employee
assignments is blocked.

Store-owned writes use the exact confirmed official name. If an original report uses a different
name, return the service's validation failure and source location so the submitter can correct the
source. Review workflows use their existing platform mapping before submitting the SMEDC
`storeName`.
