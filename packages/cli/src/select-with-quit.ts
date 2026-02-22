// @ts-nocheck
import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useRef,
  useMemo,
  useEffect,
  isBackspaceKey,
  isEnterKey,
  isUpKey,
  isDownKey,
  isNumberKey,
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
};

type NormalizedChoice<Value> = {
  value: Value;
  name: string;
  description?: string;
  short: string;
  disabled: boolean | string;
};

type SelectConfig<Value> = {
  message: string;
  choices: ReadonlyArray<Choice<Value>>;
  pageSize?: number;
  loop?: boolean;
  default?: NoInfer<Value>;
  theme?: PartialDeep<Theme<SelectTheme>>;
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
    };

    if (choice.description) {
      normalizedChoice.description = choice.description;
    }

    return normalizedChoice;
  });
}

export default (createPrompt(
  <Value>(config: SelectConfig<Value>, done: (value: Value | null) => void) => {
    const { loop = true, pageSize = 7 } = config;
    const theme = makeTheme<SelectTheme>(selectTheme, config.theme);
    const [status, setStatus] = useState<Status>("idle");
    const prefix = usePrefix({ status, theme });

    const items = useMemo(
      () => normalizeChoices(config.choices),
      [config.choices],
    );

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

    useKeypress((key, rl) => {
      if (errorMsg) {
        setError(undefined);
      }

      // Handle 'q' to quit
      if (key.name === "q") {
        setStatus("done");
        done(null);
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

        if (item.disabled) {
          const disabledLabel =
            typeof item.disabled === "string" ? item.disabled : "(disabled)";
          const disabledCursor = isActive ? theme.icon.cursor : "-";
          return theme.style.disabled(
            `${disabledCursor} ${item.name} ${disabledLabel}`,
          );
        }

        const color = isActive ? theme.style.highlight : (x: string) => x;
        return color(`${cursor} ${item.name}`);
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

    const { description } = selectedChoice;
    const lines = [
      [prefix, message].filter(Boolean).join(" "),
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
)) as any;
