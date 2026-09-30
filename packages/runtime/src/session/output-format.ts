import z from "zod"

export const OutputFormatText = z
  .object({
    type: z.literal("text"),
  })
  .meta({
    ref: "OutputFormatText",
  })

export const OutputFormatJsonSchema = z
  .object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.unknown()).meta({ ref: "JSONSchema" }),
    retryCount: z.number().int().min(0).default(2),
  })
  .meta({
    ref: "OutputFormatJsonSchema",
  })

export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
  ref: "OutputFormat",
})
export type OutputFormat = z.infer<typeof Format>
