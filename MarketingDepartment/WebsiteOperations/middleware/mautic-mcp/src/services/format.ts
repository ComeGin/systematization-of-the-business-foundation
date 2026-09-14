import type { ContactDetail, ContactSummary, ListContactsOutput } from "../schemas/contacts.js";
import type { MauticContact } from "../types.js";

// Mautic の DoNotContact.reason の値
const DNC_REASONS: Record<number, string> = { 0: "contactable", 1: "unsubscribed", 2: "bounced", 3: "manual" };

function text(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number") return String(value);
  return null;
}

export function toContactSummary(contact: MauticContact): ContactSummary {
  const fields = contact.fields.all;
  const ownerName = contact.owner ? `${contact.owner.firstName} ${contact.owner.lastName}`.trim() : null;
  return {
    id: contact.id,
    email: text(fields.email),
    firstname: text(fields.firstname),
    lastname: text(fields.lastname),
    company: text(fields.company),
    points: contact.points,
    stage: contact.stage?.name ?? null,
    owner: ownerName || null,
    tags: contact.tags.map((tag) => tag.tag),
    last_active: contact.lastActive,
    date_added: contact.dateAdded,
  };
}

export function toContactDetail(contact: MauticContact): ContactDetail {
  const fields = Object.fromEntries(
    Object.entries(contact.fields.all).filter(([key, value]) => key !== "id" && value !== null && value !== ""),
  );
  return {
    ...toContactSummary(contact),
    date_modified: contact.dateModified,
    fields,
    do_not_contact: (contact.doNotContact ?? []).map((dnc) => ({
      channel: dnc.channel,
      reason: DNC_REASONS[dnc.reason] ?? String(dnc.reason),
      comments: dnc.comments,
    })),
  };
}

function displayName(contact: ContactSummary): string {
  const name = [contact.firstname, contact.lastname].filter(Boolean).join(" ");
  return name || contact.email || "(anonymous)";
}

function summaryLines(contact: ContactSummary): string[] {
  const lines = [`## ${displayName(contact)} (ID: ${contact.id})`];
  if (contact.email) lines.push(`- **Email**: ${contact.email}`);
  if (contact.company) lines.push(`- **Company**: ${contact.company}`);
  lines.push(`- **Points**: ${contact.points}`);
  if (contact.stage) lines.push(`- **Stage**: ${contact.stage}`);
  if (contact.owner) lines.push(`- **Owner**: ${contact.owner}`);
  if (contact.tags.length) lines.push(`- **Tags**: ${contact.tags.join(", ")}`);
  lines.push(`- **Last active**: ${contact.last_active ?? "never"}`);
  return lines;
}

export function renderContactList(output: ListContactsOutput, search: string | undefined): string {
  const heading = search ? `# Contacts matching '${search}'` : "# Contacts";
  if (output.count === 0) {
    return `${heading}\n\nNo contacts found (total: ${output.total}).`;
  }

  const lines = [
    heading,
    "",
    `Showing ${output.offset + 1}-${output.offset + output.count} of ${output.total}`,
    "",
  ];
  for (const contact of output.contacts) {
    lines.push(...summaryLines(contact), "");
  }
  if (output.has_more) lines.push(`More results available: call again with offset=${output.next_offset}.`);
  if (output.truncation_message) lines.push(`Note: ${output.truncation_message}`);
  return lines.join("\n");
}

export function renderContactDetail(contact: ContactDetail): string {
  const lines = [...summaryLines(contact), `- **Added**: ${contact.date_added ?? "-"}`, `- **Modified**: ${contact.date_modified ?? "-"}`];

  if (contact.do_not_contact.length) {
    lines.push("", "### Do Not Contact");
    for (const dnc of contact.do_not_contact) {
      lines.push(`- ${dnc.channel}: ${dnc.reason}${dnc.comments ? ` (${dnc.comments})` : ""}`);
    }
  }

  lines.push("", "### Fields");
  for (const [alias, value] of Object.entries(contact.fields)) {
    lines.push(`- **${alias}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return lines.join("\n");
}
