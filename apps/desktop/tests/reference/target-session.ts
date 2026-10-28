import type {
  TargetConnection,
  TargetDescriptor,
} from "../../src/shared/contracts.js";

export interface TargetSessionResource {
  readonly connection: TargetConnection;
  close(): Promise<void>;
}

export type TargetSessionConnector<
  Resource extends TargetSessionResource = TargetSessionResource,
> = (
  signal: AbortSignal,
) => Promise<Resource>;

interface TargetSessionRecord<Resource extends TargetSessionResource> {
  readonly controller: AbortController;
  readonly connecting: TargetConnection;
  connection: TargetConnection;
  pending: Promise<Resource> | null;
  resource: Resource | null;
}

export class TargetSessionCancelledError extends Error {
  constructor(options?: ErrorOptions) {
    super("目标连接已取消", options);
    this.name = "TargetSessionCancelledError";
  }
}

export class TargetSessionRegistry<
  Resource extends TargetSessionResource = TargetSessionResource,
> {
  readonly #records = new Map<string, TargetSessionRecord<Resource>>();

  connection(targetId: string): TargetConnection | null {
    return this.#records.get(targetId)?.connection ?? null;
  }

  listConnections(): readonly TargetConnection[] {
    return [...this.#records.values()].map((record) => record.connection);
  }

  resource(targetId: string): Resource | null {
    return this.#records.get(targetId)?.resource ?? null;
  }

  updateConnection(
    targetId: string,
    resource: Resource,
    connection: TargetConnection,
  ): boolean {
    const record = this.#records.get(targetId);
    if (
      !record ||
      record.resource !== resource ||
      connection.target.id !== targetId
    ) {
      return false;
    }
    record.connection = connection;
    return true;
  }

  connect(
    target: TargetDescriptor,
    connector: TargetSessionConnector<Resource>,
  ): Promise<Resource> {
    const existing = this.#records.get(target.id);
    if (existing?.resource) {
      return Promise.resolve(existing.resource);
    }
    if (existing?.pending) {
      return existing.pending;
    }

    const controller = new AbortController();
    const connecting: TargetConnection = {
      target,
      state: "CONNECTING",
      protocolVersion: null,
      agentVersion: null,
      javaVersion: null,
      capabilities: [],
      connectedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    const record: TargetSessionRecord<Resource> = {
      controller,
      connecting,
      connection: connecting,
      pending: null,
      resource: null,
    };
    this.#records.set(target.id, record);

    const pending = Promise.resolve()
      .then(() => connector(controller.signal))
      .then(async (resource) => {
        if (
          controller.signal.aborted ||
          this.#records.get(target.id) !== record
        ) {
          await resource.close();
          throw new TargetSessionCancelledError();
        }
        record.resource = resource;
        record.connection = resource.connection;
        return resource;
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          this.#records.get(target.id) !== record
        ) {
          if (error instanceof TargetSessionCancelledError) {
            throw error;
          }
          throw new TargetSessionCancelledError({ cause: error });
        }
        record.connection = {
          ...record.connecting,
          state: "DISCONNECTED",
          errorCode: errorCode(error),
          errorMessage:
            error instanceof Error ? error.message : "目标 JVM 连接失败",
        };
        throw error;
      })
      .finally(() => {
        if (this.#records.get(target.id) === record) {
          record.pending = null;
        }
      });
    record.pending = pending;
    return pending;
  }

  async disconnect(targetId: string): Promise<void> {
    const record = this.#records.get(targetId);
    if (!record) {
      return;
    }
    this.#records.delete(targetId);
    record.controller.abort();
    await record.pending?.catch(() => undefined);
    await record.resource?.close();
  }

  async disconnectResource(
    targetId: string,
    resource: Resource,
  ): Promise<boolean> {
    if (this.#records.get(targetId)?.resource !== resource) {
      return false;
    }
    await this.disconnect(targetId);
    return true;
  }

  async deactivateResource(
    targetId: string,
    resource: Resource,
    connection: TargetConnection,
  ): Promise<boolean> {
    const record = this.#records.get(targetId);
    if (
      !record ||
      record.resource !== resource ||
      connection.target.id !== targetId ||
      connection.state !== "DISCONNECTED"
    ) {
      return false;
    }
    record.controller.abort();
    record.connection = connection;
    try {
      await resource.close();
    } finally {
      if (
        this.#records.get(targetId) === record &&
        record.resource === resource
      ) {
        record.resource = null;
      }
    }
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#records.keys()].map((targetId) =>
        this.disconnect(targetId),
      ),
    );
  }
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return "CONNECTION_FAILED";
}
