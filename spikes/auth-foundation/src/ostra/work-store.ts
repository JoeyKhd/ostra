import type { PrismaClient } from "../db/prisma-client.ts";
import { OrganizationId, ProjectId, TaskId } from "../ids.ts";
import type { MemberScope } from "./organization-scope.ts";

// ostra's own rows, read and written only through a MemberScope. Every `where`
// carries the scope's organization, and every `create` takes it from the scope:
// there is no parameter through which a caller could name another organization.

export type ProjectRow = {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly name: string;
};

export type TaskRow = {
  readonly id: TaskId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly title: string;
};

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "needs-admin" | "not-found" };

// Rows come out of Prisma as plain strings; the IDs are branded once, here, as they cross
// from the database into ostra's types.
type ProjectRecord = { readonly id: string; readonly organizationId: string; readonly name: string };
type TaskRecord = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: string;
};

const toProjectRow = (record: ProjectRecord): ProjectRow => ({
  id: ProjectId.parse(record.id),
  organizationId: OrganizationId.parse(record.organizationId),
  name: record.name,
});

const toTaskRow = (record: TaskRecord): TaskRow => ({
  id: TaskId.parse(record.id),
  organizationId: OrganizationId.parse(record.organizationId),
  projectId: ProjectId.parse(record.projectId),
  title: record.title,
});

export const createWorkStore = (prisma: PrismaClient) => ({
  listProjects: async (scope: MemberScope): Promise<ProjectRow[]> => {
    const records = await prisma.project.findMany({
      where: { organizationId: scope.organizationId },
      select: { id: true, organizationId: true, name: true },
      orderBy: { createdAt: "asc" },
    });
    return records.map(toProjectRow);
  },

  getProject: async (scope: MemberScope, id: ProjectId): Promise<ProjectRow | null> => {
    const record = await prisma.project.findFirst({
      where: { id, organizationId: scope.organizationId },
      select: { id: true, organizationId: true, name: true },
    });
    return record === null ? null : toProjectRow(record);
  },

  // Illustration of a role check on a write: only an organization admin creates projects.
  createProject: async (scope: MemberScope, name: string): Promise<WriteResult<ProjectRow>> => {
    if (scope.role !== "admin") {
      return { ok: false, reason: "needs-admin" };
    }
    const record = await prisma.project.create({
      data: { name, organizationId: scope.organizationId },
      select: { id: true, organizationId: true, name: true },
    });
    return { ok: true, value: toProjectRow(record) };
  },

  renameProject: async (scope: MemberScope, id: ProjectId, name: string): Promise<WriteResult<number>> => {
    if (scope.role !== "admin") {
      return { ok: false, reason: "needs-admin" };
    }
    const { count } = await prisma.project.updateMany({
      where: { id, organizationId: scope.organizationId },
      data: { name },
    });
    return count === 0 ? { ok: false, reason: "not-found" } : { ok: true, value: count };
  },

  deleteProject: async (scope: MemberScope, id: ProjectId): Promise<WriteResult<number>> => {
    if (scope.role !== "admin") {
      return { ok: false, reason: "needs-admin" };
    }
    const { count } = await prisma.project.deleteMany({
      where: { id, organizationId: scope.organizationId },
    });
    return count === 0 ? { ok: false, reason: "not-found" } : { ok: true, value: count };
  },

  listTasks: async (scope: MemberScope): Promise<TaskRow[]> => {
    const records = await prisma.task.findMany({
      where: { organizationId: scope.organizationId },
      select: { id: true, organizationId: true, projectId: true, title: true },
      orderBy: { createdAt: "asc" },
    });
    return records.map(toTaskRow);
  },

  // Any member may add a task. A project ID from another organization is refused
  // by the database: the composite foreign key (projectId, organizationId).
  createTask: async (scope: MemberScope, projectId: ProjectId, title: string): Promise<WriteResult<TaskRow>> => {
    const project = await prisma.project.findFirst({
      where: { id: projectId, organizationId: scope.organizationId },
      select: { id: true },
    });
    if (project === null) {
      return { ok: false, reason: "not-found" };
    }
    const record = await prisma.task.create({
      data: { title, projectId, organizationId: scope.organizationId },
      select: { id: true, organizationId: true, projectId: true, title: true },
    });
    return { ok: true, value: toTaskRow(record) };
  },
});

export type WorkStore = ReturnType<typeof createWorkStore>;
