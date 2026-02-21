import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useMemo,
  useEffect,
  isEnterKey,
  isUpKey,
  isDownKey,
  Separator,
  ValidationError,
  makeTheme,
  type Theme,
  type Status,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import type { PartialDeep } from "@inquirer/type";
import { styleText } from "node:util";
import figures from "@inquirer/figures";

type SelectTheme = {
  icon: { cursor: string };
  style: {
    disabled: (text: string) => string;
    description: (text: string) => string;
    keysHelpTip: (keys: [key: string, action: string][]) => string | undefined;
  };
  i18n: { disabledError: string };
  indexMode: "hidden" | "number";
};

const selectTheme: SelectTheme = {
  icon: { cursor: figures.pointer },
  style: {
    disabled: (text: string) => styleText("dim", text),
    description: (text: string) => styleText("cyan", text),
    keysHelpTip: (keys: [string, string][]) =>
      keys
        .map(
          ([key, action]) =>
            `${styleText("bold", key)} ${styleText("dim", action)}`,
        )
        .join(styleText("dim", " • ")),
  },
  i18n: { disabledError: "This option is disabled and cannot be selected." },
  indexMode: "hidden",
};

type Choice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
  type?: never;
  expandable?: boolean; // New: indicates this item can be expanded
  parentId?: string; // New: if this is a child item, references parent
  isChild?: boolean; // New: indicates this is a child item
  id?: string; // New: unique identifier for tracking expanded state
};

type NormalizedChoice<Value> = {
  value: Value;
  name: string;
  description?: string;
  short: string;
  disabled: boolean | string;
  expandable?: boolean;
  parentId?: string;
  isChild?: boolean;
  id?: string;
};

type ExpandableSelectConfig<Value> = {
  message: string;
  choices: ReadonlyArray<Choice<Value>>;
  pageSize?: number;
  loop?: boolean;
  default?: NoInfer<Value>;
  theme?: PartialDeep<Theme<SelectTheme>>;
  onExpand?: (value: Value) => Promise<ReadonlyArray<Choice<Value>>>;
};

function isSelectable<Value>(
  item: NormalizedChoice<Value> | Separator,
): item is NormalizedChoice<Value> {
  return !Separator.isSeparator(item) && !item.disabled;
}

function isNavigable<Value>(
  item: NormalizedChoice<Value> | Separator,
): item is NormalizedChoice<Value> {
  return !Separator.isSeparator(item);
}

function normalizeChoices<Value>(
  choices: ReadonlyArray<Choice<Value>>,
): Array<NormalizedChoice<Value>> {
  return choices.map((choice) => {
    const name = choice.name ?? String(choice.value);
    const normalizedChoice: NormalizedChoice<Value> = {
      value: choice.value,
      name,
      short: choice.short ?? name,
      disabled: choice.disabled ?? false,
      expandable: choice.expandable,
      parentId: choice.parentId,
      isChild: choice.isChild,
      id: choice.id,
    };

    if (choice.description) {
      normalizedChoice.description = choice.description;
    }

    return normalizedChoice;
  });
}

export default createPrompt(
  <Value>(
    config: ExpandableSelectConfig<Value>,
    done: (value: Value | null) => void,
  ) => {
    const { loop = true, pageSize = 15, onExpand } = config;
    const theme = makeTheme<SelectTheme>(selectTheme, config.theme);
    const [status, setStatus] = useState<Status>("idle");
    const prefix = usePrefix({ status, theme });

    const [items, setItems] = useState<Array<NormalizedChoice<Value>>>(() =>
      normalizeChoices(config.choices),
    );
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);

    const bounds = useMemo(() => {
      const first = items.findIndex(isNavigable);
      const last = items.findLastIndex(isNavigable);

      if (first === -1) {
        throw new ValidationError(
          "[select prompt] No selectable choices. All choices are disabled.",
        );
      }

      return { first, last };
    }, [items]);

    const defaultItemIndex = useMemo(() => {
      if (!("default" in config)) return -1;
      return items.findIndex(
        (item) => isSelectable(item) && item.value === config.default,
      );
    }, [config.default, items]);

    const [active, setActive] = useState(
      defaultItemIndex === -1 ? bounds.first : defaultItemIndex,
    );

    const selectedChoice = items[active] as NormalizedChoice<Value>;
    const [errorMsg, setError] = useState<string>();

    useKeypress(async (key, rl) => {
      if (errorMsg) {
        setError(undefined);
      }

      if (loading) {
        return; // Ignore keys while loading
      }

      // Handle 'q' to quit
      if (key.name === "q") {
        setStatus("done");
        done(null);
        return;
      }

      // Handle Tab to expand/collapse
      if (key.name === "tab" && selectedChoice.expandable && onExpand) {
        const itemValue = selectedChoice.value;
        const itemId = selectedChoice.id;

        if (!itemId) {
          setError("Cannot expand item without ID");
          return;
        }

        if (expanded.has(itemId)) {
          // Collapse: remove child items
          const newExpanded = new Set(expanded);
          newExpanded.delete(itemId);
          setExpanded(newExpanded);

          const newItems = items.filter((item) => item.parentId !== itemId);
          setItems(newItems);

          // Adjust active if needed
          if (active >= newItems.length) {
            setActive(newItems.length - 1);
          }
        } else {
          // Expand: fetch and add child items
          setLoading(true);
          try {
            const childChoices = await onExpand(itemValue);
            const normalizedChildren = normalizeChoices(childChoices);

            // Insert children right after the parent
            const parentIndex = items.findIndex((item) => item.id === itemId);
            const newItems = [
              ...items.slice(0, parentIndex + 1),
              ...normalizedChildren,
              ...items.slice(parentIndex + 1),
            ];
            setItems(newItems);

            const newExpanded = new Set(expanded);
            newExpanded.add(itemId);
            setExpanded(newExpanded);
          } catch (error) {
            setError(`Failed to expand: ${error}`);
          } finally {
            setLoading(false);
          }
        }
        return;
      }

      if (isEnterKey(key)) {
        if (selectedChoice.disabled) {
          setError(theme.i18n.disabledError);
        } else {
          setStatus("done");
          done(selectedChoice.value);
        }
      } else if (
        isUpKey(key, ["vim"]) ||
        isDownKey(key, ["vim"]) ||
        key.name === "k" ||
        key.name === "j"
      ) {
        rl.clearLine(0);
        const isUp = isUpKey(key, ["vim"]) || key.name === "k";
        const isDown = isDownKey(key, ["vim"]) || key.name === "j";

        if (
          loop ||
          (isUp && active !== bounds.first) ||
          (isDown && active !== bounds.last)
        ) {
          const offset = isUp ? -1 : 1;
          let next = active;
          do {
            next = (next + offset + items.length) % items.length;
          } while (!isNavigable(items[next]!));
          setActive(next);
        }
      }
    });

    const message = theme.style.message(config.message, status);

    const helpLine = theme.style.keysHelpTip([
      ["↑↓/jk", "navigate"],
      ["⏎", "select"],
      ...(selectedChoice.expandable
        ? [["tab", "expand"] as [string, string]]
        : []),
      ["q", "quit"],
    ]);

    const page = usePagination({
      items,
      active,
      renderItem({ item, isActive }) {
        if (Separator.isSeparator(item)) {
          return ` ${item.separator}`;
        }

        const cursor = isActive ? theme.icon.cursor : " ";
        const indent = item.isChild ? "  " : "";
        const expandIndicator =
          item.expandable && !item.isChild
            ? expanded.has(item.id || "")
              ? "▼ "
              : "▶ "
            : "";

        if (item.disabled) {
          const disabledLabel =
            typeof item.disabled === "string" ? item.disabled : "(disabled)";
          const disabledCursor = isActive ? theme.icon.cursor : "-";
          return theme.style.disabled(
            `${indent}${disabledCursor} ${expandIndicator}${item.name} ${disabledLabel}`,
          );
        }

        const color = isActive ? theme.style.highlight : (x: string) => x;
        return color(`${indent}${cursor} ${expandIndicator}${item.name}`);
      },
      pageSize,
      loop,
    });

    if (status === "done") {
      if (selectedChoice === null) {
        return "";
      }
      return [prefix, message, theme.style.answer(selectedChoice.short)]
        .filter(Boolean)
        .join(" ");
    }

    const loadingIndicator = loading ? styleText("dim", " (loading...)") : "";
    const { description } = selectedChoice;
    const lines = [
      [prefix, message, loadingIndicator].filter(Boolean).join(" "),
      page,
      " ",
      description ? theme.style.description(description) : "",
      errorMsg ? theme.style.error(errorMsg) : "",
      helpLine,
    ]
      .filter(Boolean)
      .join("\n")
      .trimEnd();

    return `${lines}${cursorHide}`;
  },
);
