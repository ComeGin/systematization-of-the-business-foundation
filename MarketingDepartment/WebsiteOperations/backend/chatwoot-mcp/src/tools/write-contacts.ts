import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AccessLevel } from "../config.js";
import { ConversationIdSchema, IdSchema, ResponseFormatSchema } from "../schemas/common.js";
import { describeError } from "../services/chatwoot-client.js";
import { toContactDetail } from "../services/format.js";
import { errorResult, errorText, formattedResult, jsonResult } from "../services/results.js";
import type { ApiRecord, ChatwootContact, ToolContext } from "../types.js";
import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "./annotations.js";
import { CONTACT_NOT_FOUND, renderContactDetail } from "./contacts.js";
import { CONVERSATION_NOT_FOUND } from "./conversations.js";
import { applyLabelChange, LabelChangeSchema, partialFailure, runSteps } from "./write-conversations.js";

const ContactFieldsSchema = {
  name: z.string().trim().min(1).max(255).optional(),
  email: z.email().optional(),
  phone_number: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, "Use E.164 format, e.g. +819012345678")
    .optional()
    .describe("E.164 format, e.g. +819012345678"),
  identifier: z.string().trim().min(1).max(255).optional().describe("ID of the contact in an external system (e.g. your SaaS user ID)"),
  blocked: z.boolean().optional().describe("Block the contact (their new messages are ignored)"),
  additional_attributes: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Standard extra fields, merged with existing ones: company_name, city, country, country_code, description, social_profiles'),
  custom_attributes: z.record(z.string(), z.unknown()).optional().describe("Custom attribute values (merged with existing ones on update)"),
};

async function fetchContact(ctx: ToolContext, id: number): Promise<ApiRecord> {
  const data = await ctx.client.get<{ payload: ChatwootContact }>(`/contacts/${id}`);
  return toContactDetail(data.payload, ctx.tz);
}

export function registerContactWriteTools(server: McpServer, ctx: ToolContext, accessLevel: AccessLevel): void {
  if (accessLevel === "read_only") return;
  const { client } = ctx;

  server.registerTool(
    "chatwoot_create_contact",
    {
      title: "Create Chatwoot Contact",
      description: `Create a contact. Returns the created contact with its new id.

Search first with chatwoot_list_contacts to avoid duplicates: email and identifier must be unique in the account
(a duplicate returns a validation error). Pass inbox_id to make the contact reachable in that inbox right away.

Example: name="山田 太郎", email="taro@example.com", additional_attributes={"company_name":"Example Inc."}, custom_attributes={"plan":"pro"}`,
      inputSchema: z.strictObject({
        ...ContactFieldsSchema,
        inbox_id: IdSchema("Inbox").optional().describe("Also attach the contact to this inbox"),
        labels: z.array(z.string().trim().min(1)).max(100).optional().describe("Labels to put on the new contact"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ contact: z.record(z.string(), z.unknown()) }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ labels, response_format, ...body }) => {
      if (!body.name && !body.email && !body.phone_number && !body.identifier) {
        return errorText("Error: give at least one of name, email, phone_number or identifier.");
      }
      let id: number;
      try {
        const created = await client.request<{ payload: { contact: ChatwootContact } }>("POST", "/contacts", body);
        id = created.payload.contact.id;
      } catch (error) {
        return errorResult(error, "Check inbox_id with chatwoot_list_records resource='inboxes'.");
      }
      try {
        if (labels?.length) await applyLabelChange(ctx, `/contacts/${id}`, { set: labels });
        const contact = await fetchContact(ctx, id);
        return formattedResult({ contact }, response_format, () => `Created contact ${id}\n\n${renderContactDetail(contact)}`, "");
      } catch (error) {
        return errorText(`Created contact ${id}, but setting labels or re-reading it failed: ${describeError(error)}`);
      }
    },
  );

  server.registerTool(
    "chatwoot_update_contact",
    {
      title: "Update Chatwoot Contact",
      description: `Update a contact (partial: only given fields change). additional_attributes and custom_attributes are merged with existing values;
remove_custom_attributes deletes keys. labels: { set } replaces all labels, { add, remove } edits them. Returns the updated contact.

Examples:
  - Record the company -> contact_id=12, additional_attributes={"company_name":"Example Inc."}
  - Mark as a lead -> contact_id=12, labels={add:["lead"]}, custom_attributes={"plan":"trial"}`,
      inputSchema: z.strictObject({
        contact_id: IdSchema("Contact"),
        ...ContactFieldsSchema,
        labels: LabelChangeSchema.optional(),
        remove_custom_attributes: z.array(z.string().min(1)).max(50).optional().describe("Custom attribute keys to delete"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ applied: z.array(z.string()), contact: z.record(z.string(), z.unknown()) }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ contact_id, labels, remove_custom_attributes, response_format, ...fields }) => {
      const base = `/contacts/${contact_id}`;
      const steps: [string, () => Promise<unknown>][] = [];
      if (Object.keys(fields).length > 0) steps.push(["fields", () => client.request("PUT", base, fields)]);
      if (labels) steps.push(["labels", () => applyLabelChange(ctx, base, labels)]);
      if (remove_custom_attributes) {
        steps.push(["remove_custom_attributes", () => client.request("POST", `${base}/destroy_custom_attributes`, { custom_attributes: remove_custom_attributes })]);
      }
      if (steps.length === 0) return errorText("Error: nothing to update.");

      const { done, error } = await runSteps(steps, CONTACT_NOT_FOUND);
      if (error) return partialFailure(done, error);
      try {
        const contact = await fetchContact(ctx, contact_id);
        return formattedResult({ applied: done, contact }, response_format, () => `Updated (${done.join(", ")})\n\n${renderContactDetail(contact)}`, "");
      } catch (fetchError) {
        return errorText(`Updated (${done.join(", ")}), but re-reading the contact failed: ${describeError(fetchError)}`);
      }
    },
  );

  if (accessLevel !== "full") return;

  server.registerTool(
    "chatwoot_merge_contacts",
    {
      title: "Merge Chatwoot Contacts",
      description: `Merge a duplicate contact into another. All conversations, notes and attributes of mergee_contact_id move to base_contact_id,
then mergee_contact_id is DELETED. This cannot be undone. Confirm both contacts with chatwoot_get_contact first.
Returns the remaining (base) contact.`,
      inputSchema: z.strictObject({
        base_contact_id: IdSchema("Contact that remains"),
        mergee_contact_id: IdSchema("Duplicate contact that is merged and deleted"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ base_contact_id, mergee_contact_id }) => {
      if (base_contact_id === mergee_contact_id) return errorText("Error: base_contact_id and mergee_contact_id must differ.");
      try {
        const merged = await client.request<ChatwootContact>("POST", "/actions/contact_merge", { base_contact_id, mergee_contact_id });
        return jsonResult({ merged_into: base_contact_id, deleted: mergee_contact_id, contact: toContactDetail(merged, ctx.tz) }, "");
      } catch (error) {
        return errorResult(error, CONTACT_NOT_FOUND);
      }
    },
  );

  server.registerTool(
    "chatwoot_delete_contact",
    {
      title: "Delete Chatwoot Contact",
      description: `Permanently delete a contact together with their conversations and messages. This cannot be undone.
Fails while the contact is online in the website widget. Confirm the target with chatwoot_get_contact first.`,
      inputSchema: z.strictObject({ contact_id: IdSchema("Contact") }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ contact_id }) => {
      try {
        await client.request("DELETE", `/contacts/${contact_id}`);
        return jsonResult({ deleted: "contact", id: contact_id }, "");
      } catch (error) {
        return errorResult(error, CONTACT_NOT_FOUND);
      }
    },
  );

  server.registerTool(
    "chatwoot_delete_message",
    {
      title: "Delete Chatwoot Message",
      description: `Delete a message in a conversation: its text is replaced with "This message was deleted" and attachments are removed.
Messages already delivered to the customer by email or other channels are not recalled. Find message IDs with chatwoot_list_messages.`,
      inputSchema: z.strictObject({
        conversation_id: ConversationIdSchema,
        message_id: IdSchema("Message"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ conversation_id, message_id }) => {
      try {
        await client.request("DELETE", `/conversations/${conversation_id}/messages/${message_id}`);
        return jsonResult({ deleted: "message", conversation_id, message_id }, "");
      } catch (error) {
        return errorResult(error, `${CONVERSATION_NOT_FOUND} Message IDs come from chatwoot_list_messages.`);
      }
    },
  );
}
