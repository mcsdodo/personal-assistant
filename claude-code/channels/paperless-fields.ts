/**
 * Dynamic Paperless custom field resolution.
 *
 * Fetches field IDs by name from the Paperless API at startup,
 * auto-creates any missing fields defined in FIELD_DEFS.
 */

const FIELD_DEFS: Record<string, { data_type: string }> = {
  total_amount: { data_type: "float" },
  order_id: { data_type: "string" },
};

interface CustomFieldResponse {
  id: number;
  name: string;
  data_type: string;
}

interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  results: T[];
}

export class PaperlessFieldRegistry {
  private cache = new Map<string, number>();
  private url: string;
  private token: string;
  private log: (msg: string) => void;

  constructor(url: string, token: string, log?: (msg: string) => void) {
    this.url = url;
    this.token = token;
    this.log = log ?? ((_msg: string) => {});
  }

  async init(): Promise<void> {
    // Fetch all existing custom fields (paginated)
    const existing = await this.fetchAllFields();
    for (const field of existing) {
      this.cache.set(field.name, field.id);
    }

    // Create any missing fields from FIELD_DEFS
    for (const [name, def] of Object.entries(FIELD_DEFS)) {
      if (this.cache.has(name)) continue;

      try {
        const created = await this.createField(name, def.data_type);
        this.cache.set(name, created.id);
        this.log(`Created missing custom field "${name}" with id ${created.id}`);
      } catch (e: any) {
        this.log(`Warning: failed to create custom field "${name}": ${e.message}`);
      }
    }
  }

  getFieldId(name: string): number {
    const id = this.cache.get(name);
    if (id === undefined) {
      throw new Error(`Unknown custom field: ${name}`);
    }
    return id;
  }

  private async fetchAllFields(): Promise<CustomFieldResponse[]> {
    const all: CustomFieldResponse[] = [];
    let url: string | null = `${this.url}/api/custom_fields/`;

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Token ${this.token}` },
      });
      if (!res.ok) {
        throw new Error(`Failed to list custom fields: ${res.status}`);
      }
      const data = (await res.json()) as PaginatedResponse<CustomFieldResponse>;
      all.push(...data.results);
      url = data.next;
    }

    return all;
  }

  private async createField(name: string, dataType: string): Promise<CustomFieldResponse> {
    const res = await fetch(`${this.url}/api/custom_fields/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, data_type: dataType }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`POST /api/custom_fields/ ${res.status}: ${errText.slice(0, 200)}`);
    }
    return (await res.json()) as CustomFieldResponse;
  }
}
