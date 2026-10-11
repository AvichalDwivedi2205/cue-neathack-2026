import { z } from "zod";

export const roleInput = z.enum(["owner", "engineering", "product", "support"]);
export type Role = z.infer<typeof roleInput>;
export const roleLabels: Record<Role, string> = {
  owner: "Owner",
  engineering: "Engineering",
  product: "Product",
  support: "Support",
};
const permissions = {
  owner: ["read", "support", "investigate", "deploy", "spec", "manage"],
  engineering: ["read", "investigate", "deploy"],
  product: ["read", "spec"],
  support: ["read", "support"],
} as const;
export type Permission = (typeof permissions.owner)[number];
export function can(role: Role, permission: Permission) {
  return (permissions[role] as readonly string[]).includes(permission);
}
export function requirePermission(
  actor: { role: Role },
  permission: Permission,
) {
  if (!can(actor.role, permission))
    throw new Error(
      `${roleLabels[actor.role]} role cannot perform ${permission} actions`,
    );
}
export const memberInput = z.object({
  email: z
    .email()
    .max(200)
    .transform((s) => s.toLowerCase()),
  name: z.string().trim().min(1).max(60),
  role: roleInput,
  slackId: z
    .string()
    .regex(/^[UW][A-Z0-9]+$/)
    .optional(),
});
export const membersInput = z
  .array(memberInput)
  .min(1)
  .max(20)
  .superRefine((members, ctx) => {
    const emails = members.map((m) => m.email);
    const ids = members.flatMap((m) => (m.slackId ? [m.slackId] : []));
    if (
      new Set(emails).size !== emails.length ||
      new Set(ids).size !== ids.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each email and Slack member ID must be unique",
      });
  });
export type TeamMember = z.infer<typeof memberInput>;
export function memberForEmail(
  email: string,
  verified: boolean,
  ownerEmail: string | undefined,
  members: TeamMember[] = [],
) {
  if (!verified)
    throw new Error("Verify your account email before entering Cue");
  if (ownerEmail && email.toLowerCase() === ownerEmail.toLowerCase())
    return {
      role: "owner" as const,
      name: members.find((m) => m.email === email.toLowerCase())?.name,
    };
  const member = members.find((m) => m.email === email.toLowerCase());
  if (!member) throw new Error("This account does not have operator access");
  return member;
}
type SlackTeam = { operatorIds: string[]; members?: TeamMember[] };
export function slackMember(config: SlackTeam, id: string) {
  if (config.members !== undefined)
    return config.members.find((m) => m.slackId === id);
  return config.operatorIds.includes(id)
    ? {
        role: "engineering" as const,
        name: `Slack operator ${id}`,
        slackId: id,
      }
    : undefined;
}
export function reviewers(config: SlackTeam, permission: "deploy" | "spec") {
  if (config.members === undefined)
    return permission === "deploy" ? config.operatorIds : [];
  const target = permission === "deploy" ? "engineering" : "product";
  const primary = config.members.filter((m) => m.role === target && m.slackId);
  return (
    primary.length
      ? primary
      : config.members.filter((m) => m.role === "owner" && m.slackId)
  ).map((m) => m.slackId!);
}
export function actionPermission(action: string): Permission {
  if (["seed", "reset"].includes(action)) return "manage";
  if (["approve", "reject"].includes(action)) return "deploy";
  if (
    ["investigate", "implementFeature", "cancel", "slackApproval"].includes(
      action,
    )
  )
    return "investigate";
  if (["generateSpec", "specApproval"].includes(action) || action === "spec")
    return "spec";
  if (
    [
      "report",
      "message",
      "draft",
      "tags",
      "triage",
      "emailSend",
      "slackSend",
      "link",
    ].includes(action)
  )
    return "support";
  throw new Error(`Unknown action: ${action}`);
}
