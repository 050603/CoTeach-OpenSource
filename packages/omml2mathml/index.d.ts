export interface OmmlNode {
  readonly nodeType: number;
  readonly ownerDocument?: unknown;
}

export interface MathMlElement {
  readonly outerHTML?: string;
  toString(): string;
}

declare function omml2mathml(omml: OmmlNode): MathMlElement;

export = omml2mathml;
