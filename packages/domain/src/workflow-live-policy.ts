import { z } from "zod";
import {
  workflowSourceIdentityKey,
  workflowNameSchema,
  workflowRecipientsSchema,
  WORKFLOW_LIMITS,
  WORKFLOW_DATASETS,
  type WorkflowConfiguration,
  type EnterpriseIntegrationConfiguration,
  type WorkflowActionIdentity
} from "./enterprise-workflows.js";

// Security limits are separate from the immutable business snapshot. Intersections
// only remove reach; later configuration expansion belongs to a new run.
const names = z.array(workflowNameSchema).max(WORKFLOW_LIMITS.sourceIdentities);
export const workflowLivePolicySchema = z
  .object({
    stores: names,
    datasets: z.array(z.enum(WORKFLOW_DATASETS)).max(WORKFLOW_DATASETS.length),
    channels: z.array(z.enum(["meituan", "dianping"])).max(2),
    publicationStores: names,
    senders: workflowRecipientsSchema.max(1),
    recipients: workflowRecipientsSchema,
    sources: z
      .array(
        z
          .object({
            key: z.string().max(4096),
            storeName: workflowNameSchema,
            binding: z.string().max(8192)
          })
          .strict()
      )
      .max(WORKFLOW_LIMITS.sourceIdentities),
    ignored: z.array(z.string().max(8192)).max(WORKFLOW_LIMITS.sourceIdentities),
    reviewsBlocked: z.boolean()
  })
  .strict();
export type WorkflowLivePolicy = z.infer<typeof workflowLivePolicySchema>;
const lower = (values: string[]) => values.map((v) => v.toLowerCase());
const intersect = <T extends string>(a: T[], b: T[]) => a.filter((v) => b.includes(v));
const reviewKey = (source: Parameters<typeof workflowSourceIdentityKey>[0], feedbackId: string) =>
  JSON.stringify([workflowSourceIdentityKey(source), feedbackId]);
export function workflowLivePolicy(
  config: WorkflowConfiguration,
  integration: EnterpriseIntegrationConfiguration
): WorkflowLivePolicy {
  const mail =
    config.type === "weekly-business-report"
      ? config.delivery
      : config.type === "meituan-review-operations"
        ? config.draftNotification
        : null;
  const product = config.type === "meituan-daily-ingestion" ? "meituan_erp" : "meituan_reviews";
  return {
    stores: config.storeNames,
    datasets:
      config.type === "meituan-daily-ingestion"
        ? config.datasets
        : ["business", "dishes", "in_store_orders", "takeaway_orders"],
    channels: config.type === "meituan-review-operations" ? config.channels : [],
    publicationStores:
      config.type === "meituan-review-operations" && config.publication.enabled
        ? config.publication.storeNames
        : [],
    senders: mail?.enabled && mail.allowedSender ? lower([mail.allowedSender]) : [],
    recipients: mail?.enabled ? lower(mail.recipients) : [],
    sources:
      config.type === "weekly-business-report"
        ? []
        : integration.storeMappings
            .filter(
              (m) =>
                m.source.product === product &&
                config.storeNames.includes(m.storeName) &&
                (config.type !== "meituan-review-operations" ||
                  config.channels.includes(m.source.channel as "meituan" | "dianping"))
            )
            .map((m) => {
              const account = integration.sourceAccounts.find(
                (a) => a.product === m.source.product && a.accountRef === m.source.accountRef
              )!;
              return {
                key: workflowSourceIdentityKey(m.source),
                storeName: m.storeName,
                binding: JSON.stringify([
                  m.source,
                  account.product,
                  account.accountRef,
                  account.sourceEnterpriseName,
                  account.sourceGroupName ?? null
                ])
              };
            }),
    ignored:
      config.type === "meituan-review-operations"
        ? config.ignoredReviewIdentities.map((r) => reviewKey(r.source, r.feedbackId))
        : [],
    reviewsBlocked: false
  };
}
export function intersectWorkflowLivePolicy(
  a: WorkflowLivePolicy,
  b: WorkflowLivePolicy
): WorkflowLivePolicy {
  const ignored = [...new Set([...a.ignored, ...b.ignored])];
  return {
    stores: intersect(a.stores, b.stores),
    datasets: intersect(a.datasets, b.datasets),
    channels: intersect(a.channels, b.channels),
    publicationStores: intersect(a.publicationStores, b.publicationStores),
    senders: intersect(a.senders, b.senders),
    recipients: intersect(a.recipients, b.recipients),
    sources: a.sources.filter((s) =>
      b.sources.some(
        (t) => t.key === s.key && t.storeName === s.storeName && t.binding === s.binding
      )
    ),
    ignored: ignored.slice(0, WORKFLOW_LIMITS.sourceIdentities),
    reviewsBlocked:
      a.reviewsBlocked || b.reviewsBlocked || ignored.length > WORKFLOW_LIMITS.sourceIdentities
  };
}
export function workflowLivePolicyAllows(
  policy: WorkflowLivePolicy,
  identity: WorkflowActionIdentity,
  type: WorkflowConfiguration["type"]
): boolean {
  const stores = identity.kind === "review_publish" ? [identity.storeName] : identity.storeNames;
  if (stores.some((s) => !policy.stores.includes(s))) return false;
  if (
    (identity.kind === "upload" || identity.kind === "download") &&
    !policy.datasets.includes(identity.dataset)
  )
    return false;
  if (
    type === "meituan-daily-ingestion" &&
    stores.some((s) => !policy.sources.some((m) => m.storeName === s))
  )
    return false;
  const sourceAllowed = (
    source: Parameters<typeof workflowSourceIdentityKey>[0],
    feedbackId?: string
  ) =>
    !policy.reviewsBlocked &&
    policy.channels.some((channel) => channel === source.channel) &&
    policy.sources.some(
      (m) => m.key === workflowSourceIdentityKey(source) && stores.includes(m.storeName)
    ) &&
    (!feedbackId || !policy.ignored.includes(reviewKey(source, feedbackId)));
  if (identity.kind === "review_sync" || identity.kind === "review_publish") {
    if (
      !sourceAllowed(
        identity.source,
        identity.kind === "review_publish" ? identity.feedbackId : undefined
      )
    )
      return false;
    if (
      identity.kind === "review_publish" &&
      !policy.publicationStores.includes(identity.storeName)
    )
      return false;
  }
  if (identity.kind === "email") {
    if (
      identity.purpose !== "exception" &&
      (!policy.senders.includes(identity.sender.toLowerCase()) ||
        lower(identity.recipients).some((r) => !policy.recipients.includes(r)))
    )
      return false;
    if (identity.reviewIdentities?.some((r) => !sourceAllowed(r.source, r.feedbackId)))
      return false;
  }
  return true;
}
