export type PresenceMember = {
  id: string;
  role: "teacher" | "student";
  name: string;
};

export type PresenceSnapshot = {
  members: PresenceMember[];
  showcaseReceipts?: import("@/lib/showcase/projection-receipt-types").ShowcaseProjectionReport[];
  degraded?: boolean;
  source?: "redis" | "database";
};

export function onlineStudentIds(members: PresenceMember[]): Set<string> {
  return new Set(
    members
      .filter((member) => member.role === "student" && member.id)
      .map((member) => member.id),
  );
}
