import SwaggerParser from "@apidevtools/swagger-parser"
import Ajv2020Module from "ajv/dist/2020.js"
import addFormatsModule from "ajv-formats"
import { openApiDocument } from "../../src/docs/openapi.js"

// ajv et ajv-formats sont publiés en CommonJS : selon l'outil, l'export utile est `default` ou le module lui-même.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as typeof Ajv2020Module.default
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as typeof addFormatsModule.default

// OpenAPI 3.1 utilise JSON Schema 2020-12 : il faut Ajv2020, pas la classe Ajv par défaut (draft-07),
// avec le mode strict (un mot-clé inconnu ou une faute dans un schéma fait échouer) et les formats (date-time...).
export function createSchemaValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true })
  addFormats(ajv)
  return ajv
}

// Contrat dont tous les $ref sont remplacés par leur contenu (un schéma est alors autonome).
// On travaille sur une copie : la dé-référenciation modifie l'objet qu'on lui donne.
export async function loadDereferencedContract() {
  return (await SwaggerParser.dereference(structuredClone(openApiDocument) as never)) as unknown as DereferencedContract
}

export type DereferencedOperation = {
  operationId: string
  summary: string
  description: string
  security: object[]
  "x-roles": string[]
  parameters?: { name: string; in: string; schema: object }[]
  requestBody?: unknown
  responses: Record<string, { description: string; headers?: Record<string, unknown>; content?: Record<string, { schema: object }> }>
}
export type DereferencedContract = {
  openapi: string
  paths: Record<string, Partial<Record<"get" | "post" | "patch" | "put" | "delete", DereferencedOperation>>>
  components: { schemas: Record<string, any> }
}

// Lister toutes les opérations du contrat : [méthode, chemin avec {id}, opération].
export function listOperations(contract: DereferencedContract) {
  return Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ method: method as "get" | "post" | "patch" | "delete", path, op: op as DereferencedOperation })),
  )
}
