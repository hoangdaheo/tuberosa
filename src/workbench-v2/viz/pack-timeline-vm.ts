export interface PackItem {
  id: string;
  title: string;
  tokens: number;
  matchReasons?: string[];
}

export interface Pack {
  essential: PackItem[];
  supporting: PackItem[];
  optional: PackItem[];
}

export interface PackSectionVM {
  count: number;
  tokens: number;
  items: PackItem[];
}

export interface PackVM {
  essential: PackSectionVM;
  supporting: PackSectionVM;
  optional: PackSectionVM;
  totals: { tokens: number };
}

const section = (items: PackItem[]): PackSectionVM => ({
  count: items.length,
  tokens: items.reduce((n, i) => n + i.tokens, 0),
  items,
});

export function toPackVM(pack: Pack): PackVM {
  const essential = section(pack.essential);
  const supporting = section(pack.supporting);
  const optional = section(pack.optional);
  return {
    essential,
    supporting,
    optional,
    totals: { tokens: essential.tokens + supporting.tokens + optional.tokens },
  };
}
