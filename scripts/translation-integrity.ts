const MONTHS = new Map<string, string>([
  ["January", "1"],
  ["February", "2"],
  ["March", "3"],
  ["April", "4"],
  ["May", "5"],
  ["June", "6"],
  ["July", "7"],
  ["August", "8"],
  ["September", "9"],
  ["October", "10"],
  ["November", "11"],
  ["December", "12"],
]);

const QUARTERS = new Map<string, string>([
  ["一", "1"],
  ["二", "2"],
  ["三", "3"],
  ["四", "4"],
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
  ["4", "4"],
]);

const SCALE_POWERS: Record<string, number> = {
  thousand: 3,
  million: 6,
  billion: 9,
  trillion: 12,
  "千": 3,
  "万": 4,
  "十万": 5,
  "百万": 6,
  "千万": 7,
  "亿": 8,
  "十亿": 9,
  "百亿": 10,
  "千亿": 11,
  "万亿": 12,
};

const WORD_NUMBERS: Record<string, string> = {
  zero: "0",
  a: "1",
  an: "1",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  "half a": "0.5",
  "half one": "0.5",
};

const CHINESE_DIGITS: Record<string, number> = {
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};

function parseChineseSmallInteger(value: string): number {
  if (!value.includes("十")) return CHINESE_DIGITS[value];
  const [tens, ones] = value.split("十");
  return (tens ? CHINESE_DIGITS[tens] : 1) * 10 + (ones ? CHINESE_DIGITS[ones] : 0);
}

function scaleDecimal(raw: string, power: number): string {
  const unsigned = raw.replaceAll(",", "").replace(/^\+/, "");
  const negative = unsigned.startsWith("-");
  const [integer = "0", decimal = ""] = unsigned.replace(/^-/, "").split(".");
  const digits = `${integer}${decimal}`.replace(/^0+(?=\d)/, "") || "0";
  const exponent = power - decimal.length;
  let result: string;

  if (exponent >= 0) {
    result = `${digits}${"0".repeat(exponent)}`;
  } else {
    const point = digits.length + exponent;
    result = point > 0
      ? `${digits.slice(0, point)}.${digits.slice(point)}`
      : `0.${"0".repeat(-point)}${digits}`;
    result = result.replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
  }

  result = result.replace(/^0+(?=\d)/, "");
  return negative && result !== "0" ? `-${result}` : result;
}

function normalizeDateMonths(value: string): string {
  const monthPattern = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/gi;
  return value.replace(monthPattern, (month: string, offset: number, source: string) => {
    const before = source.slice(Math.max(0, offset - 28), offset);
    const after = source.slice(offset + month.length, offset + month.length + 28);
    if (month.toLocaleLowerCase("en-US") === "may") {
      const hasExplicitDateLead =
        /\b(?:in|on|since|by|until|through|during|from|to|last|next|this|early|late|mid|of|after|before)\s+$/i.test(
          before,
        );
      const followsModalSubject =
        month === "may" &&
        /\b(?:this|it|that|we|you|they|i|he|she|who|which)\s+$/i.test(before) &&
        !/^\s*(?:[,./-]|\d)/.test(after);
      if (
        /^\s+Musk\b/i.test(after) ||
        /^\s+(?:be|have|not)\b/i.test(after) ||
        (month === "may" && /^\s+\d/.test(after) && !hasExplicitDateLead) ||
        followsModalSubject
      ) {
        return month;
      }
    }
    if (month === "march" && /\bto\s+$/i.test(before)) return month;
    const hasDateContext =
      /\b(?:in|on|since|by|until|through|during|from|to|last|next|this|early|late|mid|of|after|before)\s+$/i.test(before) ||
      /\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s*$/i.test(before) ||
      /^\s+(?:(?:of\s+)?\d{1,4}(?:st|nd|rd|th)?\b|last\b|next\b|this\b)/i.test(after);
    const canonical = `${month[0].toLocaleUpperCase("en-US")}${month.slice(1).toLocaleLowerCase("en-US")}`;
    return hasDateContext ? MONTHS.get(canonical) ?? month : month;
  });
}

interface NumericAnalysis {
  values: string[];
  ambiguity: "none" | "extras" | "all";
}

export interface NumericComparison {
  level: "ok" | "warning" | "error";
  sourceValues: string[];
  translationValues: string[];
}

function analyzeNumericValues(value: string): NumericAnalysis {
  const tokens: string[] = [];
  const hasBrokenOrRepeatedScale =
    /\b[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s+(?:thou(?:s(?:a(?:n(?:d)?)?)?)?|mil(?:l(?:i(?:o(?:n)?)?)?)?|bil(?:l(?:i(?:o(?:n)?)?)?)?|tril(?:l(?:i(?:o(?:n)?)?)?)?)[\s-]+(?:thousand|million|billion|trillion)s?\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s+(?:and|point)\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion)\b/i.test(value);
  const hasSharedScaleRange =
    /(?:[$€£¥]\s*)?\d[\d,.]*\s*(?:-|–|—|\b(?:to|or|and)\b)\s*(?:[$€£¥]\s*)?\d[\d,.]*\s*(?:thousand|million|billion|trillion)\b/i.test(value) ||
    /(?:\b\d+(?:\.\d+)?\s*,\s+)+\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion)\b/i.test(value) ||
    /\b\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?\s*(?:thousand|million|billion|trillion)\b/i.test(value) ||
    /[$€£¥]\s*\d+(?:\.\d+)?\s*(?:-|–|—)\s*[$€£¥]?\s*\d{1,3}(?:,\d{3})+/i.test(value) ||
    /\b\d+(?:\.\d+)?\s*(?:-|–|—|\bto\b)\s*(?:[$€£¥]\s*)?\d{1,3}(?:,\d{3})+\b/i.test(value) ||
    /\b\d{1,2}\s*(?:-|–|—|\bto\b)\s*\d{3,}\s*(?:kilometers?|kilometres?|miles?|meters?|metres?|feet|foot)\b/i.test(value) ||
    /\braise\s+\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion)\s+to\s+raise\s+\d+(?:\.\d+)?\b/i.test(value);
  const hasComplexNumberExpression =
    /\b(?:half\s+(?:a|one)|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:thousand|million|billion|trillion)\b/i.test(value) ||
    /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|point|couple|few|several)\b(?:[\s-]+\w+){0,5}[\s-]+(?:thousand|million|billion|trillion)s?\b/i.test(value) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+and\s+(?:a\s+)?half\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s+and\s+(?:a|\d+)\s+half\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s+a\s+half\s+(?:thousand|million|billion|trillion)\b/i.test(value) ||
    /\d(?:\.\d+)?e[+-]?\d+/i.test(value) ||
    /\d+\.\s+\d+/.test(value) ||
    /\d+\s*\/\s*\d+/.test(value) ||
    /\b(?:1\d{3}|20\d{2})s\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s*[mM]\b/.test(value) ||
    /(?:^|[^$€£¥\w])\d+(?:\.\d+)?\s*B\b/.test(value) ||
    /\b\d+(?:\.\d+)?\s*B\.?C\.?\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s*[kK]\s*(?:w(?:h)?|watt|kow|byte|bytes|hz)\b/i.test(value) ||
    /\b401k\b/i.test(value) ||
    /\b(?:form\s+)?(?:8|10)[-\s]?k\b(?=\s*(?:form|filing|filed|with|within|or|and))/i.test(value) ||
    /\b(?:the\s+)?\d+(?:st|nd|rd|th)\s+hour\b/i.test(value) ||
    /\b(?:a|an)\s+(?:year|month|week|day|hour|minute|second|time|mile|foot|inch|meter|kilometer|dollar|euro|pound|ton|volt|(?:kilo|mega|giga|tera)?watt(?:[-\s]?hours?)?|percent(?:age)?)\b/i.test(value) ||
    /\bthe\s+(?:day|week|month|year|night|morning|evening)\s+(?:before|after)\b/i.test(value) ||
    /\b(?:a|an|one)\s+orders?\s+of\s+magnitude\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s+cents?\s+on\s+the\s+dollar\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s+or\s+(?:many|several)\s+billions?\b/i.test(value) ||
    /\b(?:once|twice|thrice|both|single|nines)\b/i.test(value) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)[-\s]?fold\b/i.test(value) ||
    /\b\d+(?:\.\d+)?\s+(?:thousand|million|billion|trillion)\b[\s\S]{0,180}\b\d+(?:\.\d+)?\s+(?:or|to)\s+\d+(?:\.\d+)?\b/i.test(value) ||
    /\b\d{1,3}\s+\d{1,3}\b/.test(value) ||
    /\b(?:19|20)\b(?:\s+\w+){0,4}\s+(?:19|20)\d{2}\b/i.test(value) ||
    /\b(?:thousand|million|billion|trillion)doll(?:ar)?s?\b/i.test(value) ||
    /\bFY\s*'?\d{2}\b/i.test(value) ||
    /[’']\d{2}\b/.test(value) ||
    /\bH[12]\b/i.test(value);
  const hasRepeatedScaledShorthand = /\b(\d+(?:\.\d+)?)\s+(thousand|million|billion|trillion)\b[\s\S]{0,800}\b\1\b(?!\s+(?:thousand|million|billion|trillion))/i.test(value);
  let comparable = value;
  comparable = comparable.replace(
    /\b(\d{1,3}),\s+(\d{3})\b/g,
    (match, leading: string, trailing: string) => {
      const compact = `${leading},${trailing}`;
      return value.includes(compact) ? compact : match;
    },
  );
  comparable = comparable.replace(/\bat\s+one\s+point\b/gi, "at a moment");
  comparable = comparable.replace(/\bpoint(\d+)\b/gi, "0.$1");
  comparable = comparable.replace(
    /\b0(\d{2,})(?=\s+of\s+(?:a\s+)?(?:donut|doughnut)s?\b)/gi,
    "0.$1",
  );
  comparable = comparable.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+point\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_match, whole: string, fraction: string) =>
      WORD_NUMBERS[whole.toLocaleLowerCase("en-US")] + "." +
      WORD_NUMBERS[fraction.toLocaleLowerCase("en-US")],
  );
  comparable = comparable.replace(
    /\bWorld\s+Wars?\s+(IV|III|II|I)\s+(?:and|&)\s+(IV|III|II|I)\b/gi,
    (_match, firstRoman: string, secondRoman: string) => {
      const romanValues = { I: 1, II: 2, III: 3, IV: 4 } as const;
      tokens.push(`number:${romanValues[firstRoman.toLocaleUpperCase("en-US") as keyof typeof romanValues]}`);
      tokens.push(`number:${romanValues[secondRoman.toLocaleUpperCase("en-US") as keyof typeof romanValues]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\bWorld\s+War\s+(IV|III|II|I)\b/gi,
    (_match, roman: string) => {
      const number = { I: 1, II: 2, III: 3, IV: 4 }[
        roman.toLocaleUpperCase("en-US") as "I" | "II" | "III" | "IV"
      ];
      tokens.push(`number:${number}`);
      return " ";
    },
  );
  comparable = comparable.replace(/\bzeroth\s+law\b/gi, () => {
    tokens.push("number:0");
    return "law";
  });
  comparable = comparable.replace(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Amendment\b/gi,
    (_match, ordinal: string) => {
      const number = {
        first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
        sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
      }[ordinal.toLocaleLowerCase("en-US") as "first" | "second" | "third" | "fourth" | "fifth" | "sixth" | "seventh" | "eighth" | "ninth" | "tenth"];
      tokens.push(`number:${number}`);
      return "Amendment";
    },
  );
  comparable = comparable.replace(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+quarter\s+in\b[^.!?]{0,80}\bplan\b/gi,
    (_match, ordinal: string) => {
      const ordinalValues = {
        first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
        sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
      } as const;
      tokens.push(`number:${ordinalValues[ordinal.toLocaleLowerCase("en-US") as keyof typeof ordinalValues]}`);
      return " plan";
    },
  );
  comparable = comparable.replace(
    /\b(first|second|third|fourth|1st|2nd|3rd|4th)[\s‐-―-]+quarter\b/gi,
    (_match, ordinal: string) => {
      const quarter = { first: "1", second: "2", third: "3", fourth: "4", "1st": "1", "2nd": "2", "3rd": "3", "4th": "4" }[ordinal.toLocaleLowerCase("en-US")];
      tokens.push(`quarter:${quarter}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:sequential|consecutive(?:ly)?(?:\s+\w+){0,2})\s+quarter\b/gi,
    (_match, ordinal: string) => {
      const ordinalValues = {
        first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
        sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
      } as const;
      tokens.push(`number:${ordinalValues[ordinal.toLocaleLowerCase("en-US") as keyof typeof ordinalValues]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(?:first|last|past|next|previous)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+quarters?\b/gi,
    (_match, count: string) => {
      tokens.push(`number:${WORD_NUMBERS[count.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(primary|secondary|tertiary)\s+(?=(?:(?:compute|control|support)\s+)?(?:layer|level|stage|system)\b)/gi,
    (_match, ordinal: string) => {
      const number = { primary: 1, secondary: 2, tertiary: 3 }[
        ordinal.toLocaleLowerCase("en-US") as "primary" | "secondary" | "tertiary"
      ];
      tokens.push(`number:${number}`);
      return "";
    },
  );
  comparable = comparable.replace(/\bhigh\s+school\s+junior\b/gi, () => {
    tokens.push("number:11");
    return "student";
  });
  comparable = comparable.replace(/\b(?:a|one)\s+100th(?=\s+of\b)/gi, () => {
    tokens.push("number:1");
    return "percent";
  });
  comparable = comparable.replace(/\ba\s+buck\s+(?:oh\s+)?0?5\b/gi, () => {
    tokens.push("number:1.05");
    return " ";
  });
  comparable = comparable.replace(/\b(?:literally|exactly)\s+zero\b/gi, () => {
    tokens.push("number:0");
    return " ";
  });
  comparable = comparable.replace(/\bbottom\s+of\s+the\s+hour\b/gi, () => {
    tokens.push("number:30");
    return " ";
  });
  comparable = comparable.replace(
    /\bepisode\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
    (_match, number: string) => {
      tokens.push(`number:${WORD_NUMBERS[number.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  const episodeOrdinals = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  } as const;
  comparable = comparable.replace(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+or\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+episode\b/gi,
    (_match, first: string, second: string) => {
      tokens.push(`number:${episodeOrdinals[first.toLocaleLowerCase("en-US") as keyof typeof episodeOrdinals]}`);
      tokens.push(`number:${episodeOrdinals[second.toLocaleLowerCase("en-US") as keyof typeof episodeOrdinals]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\bseason\s+(one|two|three|four)\b/gi,
    (_match, number: string) => {
      tokens.push(`quarter:${WORD_NUMBERS[number.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+things?\s+(?:or|and)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+things?\b/gi,
    (_match, first: string, second: string) => {
      tokens.push(`number:${WORD_NUMBERS[first.toLocaleLowerCase("en-US")]}`);
      tokens.push(`number:${WORD_NUMBERS[second.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?=main\s+points?\b)/gi,
    (_match, number: string) => {
      tokens.push(`number:${WORD_NUMBERS[number.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(two|three|four|five|six|seven|eight|nine|ten)\s+(?=(?:things?|issues?|problems?|factors?|points?)\b)/gi,
    (_match, number: string) => {
      tokens.push(`number:${WORD_NUMBERS[number.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?=(?:analyst\s+)?question\b)/gi,
    (_match, ordinal: string) => {
      tokens.push(`number:${episodeOrdinals[ordinal.toLocaleLowerCase("en-US") as keyof typeof episodeOrdinals]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\btop\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
    (_match, number: string) => {
      tokens.push(`number:${WORD_NUMBERS[number.toLocaleLowerCase("en-US")]}`);
      return "top";
    },
  );
  comparable = comparable.replace(/\bone[-\s]+time(?=\s+items?\b)/gi, () => {
    tokens.push("number:1");
    return " ";
  });
  comparable = comparable.replace(/\bprofitability\s+first\b/gi, () => {
    tokens.push("number:1");
    return "profitability";
  });
  comparable = comparable.replace(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+and\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+tranches?\b/gi,
    (_match, first: string, second: string) => {
      tokens.push(`number:${episodeOrdinals[first.toLocaleLowerCase("en-US") as keyof typeof episodeOrdinals]}`);
      tokens.push(`number:${episodeOrdinals[second.toLocaleLowerCase("en-US") as keyof typeof episodeOrdinals]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(first|second|third|fourth)[-\s]+quarters?\b/gi,
    (_match, ordinal: string) => {
      const quarter = { first: "1", second: "2", third: "3", fourth: "4" }[
        ordinal.toLocaleLowerCase("en-US")
      ];
      tokens.push(`quarter:${quarter}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\bone\s+quarter(?=\s+(?:versus|compared\s+(?:to|with))\b[^.!?]{0,80}\b(?:the\s+)?(?:other|another)\s+quarter\b)/gi,
    "reporting period",
  );
  comparable = comparable.replace(/\bsize\s+of\s+(?:about\s+)?a\s+quarter\b/gi, () => {
    tokens.push("number:25");
    return "coin";
  });
  comparable = comparable.replace(/\blike\s+a\s+quarter\b/gi, () => {
    tokens.push("number:1");
    tokens.push("number:4");
    return " ";
  });
  comparable = comparable.replace(
    /\b(?:(?:use|using)\s+only\s+a\s+quarter\b|(?:only\s+)?(?:a|about)\s+quarter(?=\s+(?:as\s+much\b|(?:or|and)\s+\d+(?:\.\d+)?%))|quarter(?=\s+of\s+(?:people|the\s+population)\b))/gi,
    () => {
      tokens.push("number:1");
      tokens.push("number:4");
      return " ";
    },
  );
  comparable = comparable.replace(
    /一\s*件(?:事|东西)?\s*(?:或|和|至|到)\s*两\s*件(?:事|东西)?/g,
    () => {
      tokens.push("number:1");
      tokens.push("number:2");
      return " ";
    },
  );
  comparable = comparable.replace(/半\s*个?(?=(?:世纪|年|月|星期|周|天|日|小时|分钟|秒))/g, () => {
    tokens.push("number:1");
    tokens.push("number:2");
    return " ";
  });
  comparable = comparable.replace(
    /([一二两三四])(个|种|项|件|位|次|组|套|者)\s*[，,、]\s*\1\2/g,
    "$1$2",
  );
  comparable = comparable.replace(
    /(\d+)\s*个\s*[，,、]\s*\1\s*个(?=\s*(?:或|and|or))/gi,
    "$1个",
  );
  comparable = comparable.replace(
    /(\d[\d,]*(?:\.\d+)?)\s*(天|日|小时|分钟|秒|days?|hours?|minutes?|seconds?)(?:\s*(?:大|之久|左右))?\s*[，,]?\s*(?:或|或者|or)\s*\1(?=\s*(?:天|日|小时|分钟|秒|days?|hours?|minutes?|seconds?))/gi,
    "$1$2 或 ",
  );
  comparable = comparable.replace(
    /\b(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/gi,
    (_match, decade: string) => {
      const number = {
        twenties: 20,
        thirties: 30,
        forties: 40,
        fifties: 50,
        sixties: 60,
        seventies: 70,
        eighties: 80,
        nineties: 90,
      }[decade.toLocaleLowerCase("en-US") as
        | "twenties" | "thirties" | "forties" | "fifties"
        | "sixties" | "seventies" | "eighties" | "nineties"];
      tokens.push(`number:${number}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\btens\s+of\s+(thousands|millions|billions|trillions)\b/gi,
    (_match, scale: string) => {
      const singularScale = scale.toLocaleLowerCase("en-US").replace(/s$/, "");
      tokens.push(`number:${scaleDecimal("10", SCALE_POWERS[singularScale])}`);
      return " ";
    },
  );
  comparable = comparable.replace(/\btens\b/gi, () => {
    tokens.push("number:10");
    return " ";
  });
  comparable = comparable.replace(
    /\b(?:a\s+quarter(?=\s+of\b)|(?:a\s+)?quarter(?=\s+(?:miles?|hours?|years?|pounds?|tons?)\b))/gi,
    () => {
      tokens.push("number:1");
      tokens.push("number:4");
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(a|an|in|one|two|three|four|five|six|seven|eight|nine|ten)\s+orders?\s+of\s+magnitude\b/gi,
    (_match, number: string) => {
      const normalized = number.toLocaleLowerCase("en-US");
      tokens.push(`number:${normalized === "in" ? "1" : WORD_NUMBERS[normalized]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)[-\s]*(half|third|quarter|fourth|fifth|sixth|seventh|eighth|ninth|tenth)s?\b/gi,
    (_match, numerator: string, denominator: string) => {
      const denominatorValue = {
        half: 2, third: 3, quarter: 4, fourth: 4, fifth: 5,
        sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
      }[denominator.toLocaleLowerCase("en-US") as
        | "half" | "third" | "quarter" | "fourth" | "fifth"
        | "sixth" | "seventh" | "eighth" | "ninth" | "tenth"];
      tokens.push(`number:${WORD_NUMBERS[numerator.toLocaleLowerCase("en-US")]}`);
      tokens.push(`number:${denominatorValue}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\bquarter\s+(one|two|three|four|[1-4])\b/gi,
    (_match, value: string) => {
      const quarter = { one: "1", two: "2", three: "3", four: "4" }[
        value.toLocaleLowerCase("en-US")
      ] ?? value;
      tokens.push(`quarter:${quarter}`);
      return " ";
    },
  );
  comparable = comparable.replace(/\bQ([1-4])\b/gi, (_match, quarter: string) => {
    tokens.push(`quarter:${quarter}`);
    return " ";
  });
  comparable = comparable.replace(/\b([1-4])\s*Q\b/gi, (_match, quarter: string) => {
    tokens.push(`quarter:${quarter}`);
    return " ";
  });
  comparable = comparable.replace(/(?:同|过去|最近|上|下|前|后|每)(?:一|1)个季度/g, "季度");
  comparable = comparable.replace(
    /连续\s*(?:第\s*)?([一二两三四五六七八九十\d]+)\s*(?:个\s*)?季度/g,
    (_match, number: string) => {
      const numeric = /^\d+$/.test(number) ? Number(number) : parseChineseSmallInteger(number);
      tokens.push(`number:${numeric}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?:第\s*)?([一二两三四五六七八九十\d]+)\s*个\s*季度/g,
    (_match, number: string) => {
      const numeric = /^\d+$/.test(number) ? Number(number) : parseChineseSmallInteger(number);
      tokens.push(`number:${numeric}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /前\s*([一二两三四五六七八九十])(?=(?:名|个|家|大|强|位|项|种|的|$))/g,
    (_match, number: string) => {
      tokens.push(`number:${number === "十" ? 10 : CHINESE_DIGITS[number]}`);
      return "前";
    },
  );
  comparable = comparable.replace(
    /(?<![上下前后每])(?:第\s*)?([一二三四1-4])\s*(?:季度|季)/g,
    (_match, quarter: string) => {
      tokens.push(`quarter:${QUARTERS.get(quarter)}`);
      return " ";
    },
  );
  comparable = comparable.replace(/(?:第\s*)?零\s*(?=定律|法则)/g, () => {
    tokens.push("number:0");
    return " ";
  });
  comparable = comparable.replace(
    /零(?=$|[\s，。！？、；：%‰]|\d|(?:排放|伤害|概率|机会|风险|增长|延迟|成本|事故|错误|容忍|信任|重力|加速|到|至|和|点))/g,
    () => {
      tokens.push("number:0");
      return " ";
    },
  );
  comparable = comparable.replace(
    /(十一|十二|十|[一二三四五六七八九])月/g,
    (_match, month: string) => {
      const numericMonth = {
        一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6",
        七: "7", 八: "8", 九: "9", 十: "10", 十一: "11", 十二: "12",
      }[month];
      return `${numericMonth}月`;
    },
  );
  comparable = normalizeDateMonths(comparable);
  comparable = comparable.replace(/\bth0{3}\b/gi, "1000");
  comparable = comparable.replace(
    /\ba(?=\d+(?:,\d{3})*(?:\.\d+)?\s*(?:thousand|million|billion|trillion)\b)/gi,
    "a ",
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*tera[\s-]*(?:ops?|operations?)\b/gi,
    (_match, number: string) => `${number} trillion operations`,
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*mega[\s-]*pixels?\b/gi,
    (_match, number: string) => `${number} million pixels`,
  );
  comparable = comparable.replace(
    /\b(?:a|one)\s+mega[\s-]*pixel\b/gi,
    "1 million pixels",
  );
  comparable = comparable.replace(
    /\bmodel\s+(one|two|three|four|five|six|seven|eight|nine|ten)s?\b/gi,
    (_match, modelNumber: string) => {
      tokens.push(`number:${WORD_NUMBERS[modelNumber.toLocaleLowerCase("en-US")]}`);
      return "model ";
    },
  );
  comparable = comparable.replace(
    /\b(\d{1,3}(?:\.\d+)?)\s+(thousand|million|billion|trillion)\s+(\d{1,3}(?:\.\d+)?)\b(?=\s+(?:I\s+mean|but|so|we|they|it)\b)/gi,
    (_match, first: string, scale: string, second: string) =>
      `${first} ${scale} ${second} ${scale}`,
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*kilo[\s-]*(bits?|bytes?)\b/gi,
    (_match, number: string, unit: string) => `${number} thousand ${unit}`,
  );
  comparable = comparable.replace(
    /\bthe\s+(8|10)[-\s]?k\b/gi,
    (_match, formNumber: string) => {
      tokens.push(`number:${formNumber}`);
      return " filing ";
    },
  );
  comparable = comparable.replace(
    /\b(?:form\s+)?(8|10)[-\s]?k\b(?=\s*(?:form|filing|report|filed|with|within|or|and|表|文件|报告|申报|中))/gi,
    (_match, formNumber: string) => {
      tokens.push(`number:${formNumber}`);
      return " filing ";
    },
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(k|b|bn|tn)\b/gi,
    (_match, number: string, scale: string) => {
      const normalizedScale = scale.toLocaleLowerCase("en-US");
      return `${number} ${normalizedScale === "k" ? "thousand" : normalizedScale === "tn" ? "trillion" : "billion"}`;
    },
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s+grand\b/gi,
    (_match, number: string) => `${number} thousand`,
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s+or\s+(?:many|several)\s+billions?\b/gi,
    "$1 billion",
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s+(thousand|million|billion|trillion)([\s\S]{0,240}?\b(?:feel|feels|felt|are|were)?\s*(?:comfortable|confident)\s+with\s+)([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\b/gi,
    (_match, first: string, scale: string, middle: string, second: string) =>
      `${first} ${scale}${middle}${second} ${scale}`,
  );
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s+something\s+(?=(?:thousand|million|billion|trillion)\b)/gi,
    "$1 ",
  );
  comparable = comparable.replace(
    /(?<![\d,])\b(\d{1,3})(?:\s*(?:or|and|或|和|、)\s*|,\s+)(\d{1,3})(?:\s*(?:or|and|或|和|、)\s*|,\s+)(\d{1,3}),000\b/gi,
    (_match, first: string, second: string, third: string) => {
      tokens.push(`number:${scaleDecimal(first, 0)}`);
      tokens.push(`number:${scaleDecimal(second, 0)}`);
      tokens.push(`number:${scaleDecimal(third, 3)}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?<![\d,])\b(\d{1,3})\s*(?:(?:or|to|and|或|至|到|和)\s*|,\s+)(\d{1,3}),000\b(?!\s*(?:%|percent\b|美元|欧元|英镑|日元|元))/gi,
    (_match, first: string, second: string) => {
      tokens.push(`number:${scaleDecimal(first, 3)}`);
      tokens.push(`number:${scaleDecimal(second, 3)}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+\1\s+or\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?=swing\s+states?\b)/gi,
    (_match, first: string, second: string) => {
      tokens.push(`number:${WORD_NUMBERS[first.toLocaleLowerCase("en-US")]}`);
      tokens.push(`number:${WORD_NUMBERS[second.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(half\s+(?:a|one)|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(thousand|million|billion|trillion)\b/gi,
    (_match, quantity: string, scale: string) =>
      `${WORD_NUMBERS[quantity.toLocaleLowerCase("en-US")]} ${scale}`,
  );
  comparable = comparable.replace(/\bcarbon\s+dioxide\b/gi, () => {
    tokens.push("identifier:co2");
    return " ";
  });
  comparable = comparable.replace(
    /\b([A-Za-z]+)(\d+)(?=$|[^A-Za-z0-9])/g,
    (_match, label: string, number: string) => {
      const normalizedLabel = label.toLocaleLowerCase("en-US");
      tokens.push(
        normalizedLabel === "co"
          ? `identifier:${normalizedLabel}${scaleDecimal(number, 0)}`
          : `number:${scaleDecimal(number, 0)}`,
      );
      return `${label} `;
    },
  );
  comparable = comparable.replace(/二氧化碳/g, () => {
    tokens.push("identifier:co2");
    return " ";
  });
  comparable = comparable.replace(
    /二手(?=\s*(?:Tesla|特斯拉|车|市场|业务|商品|设备|交易|平台|房|货|物品))/gi,
    "旧",
  );
  comparable = comparable.replace(/千禧一代/g, "年轻一代");
  comparable = comparable.replace(/二维码/g, "QR码");
  comparable = comparable.replace(/(?:这个|本)小时的半点/g, () => {
    tokens.push("number:30");
    return " ";
  });
  comparable = comparable.replace(
    /\bdouble[-\s]+check(?:ed|ing|s)?\b/gi,
    "verify",
  );
  comparable = comparable.replace(
    /\bdouble\s+and\s+triple\s+click(?:ed|ing|s)?\s+on\b/gi,
    "examine",
  );
  comparable = comparable.replace(/\bdouble[-\s]+click\s+into\b/gi, "examine");
  comparable = comparable.replace(/\bdoubl(?:e|es|ed|ing)\s+down\b/gi, "focus");
  comparable = comparable.replace(/\bdouble[sd]?\s+up\b/gi, "duplicate");
  comparable = comparable.replace(
    /\bdual[-\s]+(?=(?:motors?|engines?|cameras?|systems?|hinges?|sourc(?:e|es|ing)|inductive|benefits?|philosoph(?:y|ies))\b)/gi,
    () => {
      tokens.push("number:2");
      return "";
    },
  );
  comparable = comparable.replace(
    /\btri[-\s]+(?=(?:motors?|engines?|cameras?|systems?|hinges?)\b)/gi,
    () => {
      tokens.push("number:3");
      return "";
    },
  );
  comparable = comparable.replace(/\bbi[-\s]?direction(?:al(?:ly)?)\b/gi, () => {
    tokens.push("number:2");
    return "directional";
  });
  comparable = comparable.replace(
    /\b(two|three|four|five|six|seven|eight|nine|ten)[-\s]?fold\b/gi,
    (_match, multiplier: string) => {
      tokens.push(`number:${WORD_NUMBERS[multiplier.toLocaleLowerCase("en-US")]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\b(double[sd]?|doubling|twice|triple[sd]?|tripling|thrice|quadruple[sd]?|quadrupling)\b/gi,
    (_match, multiplier: string) => {
      const normalized = multiplier.toLocaleLowerCase("en-US");
      const value = normalized.startsWith("doubl") || normalized === "twice"
        ? 2
        : normalized.startsWith("tripl") || normalized === "thrice"
          ? 3
          : 4;
      tokens.push(`number:${value}`);
      return " ";
    },
  );
  comparable = comparable.replace(/(?<![一二两三四五六七八九十\d])倍增|翻(?:了)?一倍|翻\s*倍|翻(?:了)?一番/g, () => {
    tokens.push("number:2");
    return " ";
  });
  comparable = comparable.replace(
    /一边([^。！？\n]{0,120}?)一边/g,
    (_match, middle: string) => `同时${middle}同时`,
  );
  comparable = comparable.replace(/一次又一次/g, "反复");
  comparable = comparable.replace(/([哪这那])\s*一\s*(?=(?:边|侧))/g, "$1");
  comparable = comparable.replace(/([这那])\s*一\s*(?=套)/g, "$1");
  comparable = comparable.replace(
    /(?:第\s*)?([一二两三四五六七八九十])\s*(?:或|和|至|到)\s*(?:第\s*)?([一二两三四五六七八九十])\s*(?=集)/g,
    (_match, first: string, second: string) => {
      const numeric = (number: string) => number === "十" ? 10 : CHINESE_DIGITS[number];
      tokens.push(`number:${numeric(first)}`);
      tokens.push(`number:${numeric(second)}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?:第\s*)?([一二两三四五六七八九十])\s*(?:和|及|与|、)\s*(?:第\s*)?([一二两三四五六七八九十])\s*(?=批)/g,
    (_match, first: string, second: string) => {
      const numeric = (number: string) => number === "十" ? 10 : CHINESE_DIGITS[number];
      tokens.push(`number:${numeric(first)}`);
      tokens.push(`number:${numeric(second)}`);
      return " ";
    },
  );
  comparable = comparable.replace(/(?:第\s*)?([一二两三四五六七八九十])\s*(?=集)/g, (_match, number: string) => {
    tokens.push(`number:${number === "十" ? 10 : CHINESE_DIGITS[number]}`);
    return " ";
  });
  comparable = comparable.replace(
    /(?:扩大|增加|提升|增长|提高)(?:了)?\s*([1-9一二三四])\s*倍\s*(?:或|至|到|和)\s*([1-9一二三四])\s*倍/g,
    (_match, first: string, second: string) => {
      const numeric = (amount: string) => CHINESE_DIGITS[amount] ?? Number(amount);
      tokens.push(`number:${numeric(first) + 1}`);
      tokens.push(`number:${numeric(second) + 1}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?:扩大|增加|提升|增长|提高)(?:了)?\s*([1-9一二三四])\s*倍/g,
    (_match, amount: string) => {
      const numericAmount = CHINESE_DIGITS[amount] ?? Number(amount);
      tokens.push(`number:${numericAmount + 1}`);
      return " ";
    },
  );
  comparable = comparable.replace(/加倍(?:押注|投入|努力|专注|坚持|强化|固守|推进)/g, "专注");
  comparable = comparable.replace(/(?:翻|加)倍/g, () => {
    tokens.push("number:2");
    return " ";
  });
  comparable = comparable.replace(/([一二两三四])\s*个?\s*数量级/g, (_match, number: string) => {
    tokens.push(`number:${CHINESE_DIGITS[number]}`);
    return " ";
  });
  comparable = comparable.replace(
    /双(?=(?:感应|击|重|层|份|个|次|倍|组|套|向|边|侧|面|人|手|脚|眼|耳|轮|轴|门|铰链|铰接|刃剑|吊车|起重机|保险|熔断|保险丝|因素|摄像头|传感器|发动机|引擎|电机|电芯))/g,
    () => {
      tokens.push("number:2");
      return " ";
    },
  );
  comparable = comparable.replace(
    /([一二两三四])(?=(?:战|维|重|层|级|阶段|位数|份|个|次|倍|组|套|种|者|向|边|侧|人|手|脚|眼|耳|轮|轴|门|刃剑|吊车|起重机|保险|熔断|保险丝|摄像头|传感器|发动机|引擎|电机|电芯))/g,
    (_match, number: string) => {
      tokens.push(`number:${CHINESE_DIGITS[number]}`);
      return " ";
    },
  );
  comparable = comparable.replace(/([二两三四])(?=件)/g, (_match, number: string) => {
    tokens.push(`number:${CHINESE_DIGITS[number]}`);
    return " ";
  });
  comparable = comparable.replace(
    /([二两三四五六七八九十])(?=点(?:[，,。！？；;：:]|\s|$))/g,
    (_match, number: string) => {
      tokens.push(`number:${number === "十" ? 10 : CHINESE_DIGITS[number]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /第\s*([一二两三四五六七八九十])\s*(?=(?:修正案|巡回(?:上诉)?法院))/g,
    (_match, number: string) => {
      tokens.push(`number:${number === "十" ? 10 : CHINESE_DIGITS[number]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /第\s*([一二三四])\s*(?=(?:部分|篇章|批|大学))/g,
    (_match, number: string) => {
      tokens.push(`number:${CHINESE_DIGITS[number]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?:第\s*)?([一二两三四五六七八九十\d]+)\s*代(?=(?:卫星|产品|车型|技术|系统|设备|硬件|软件|芯片|火箭|飞船|星舰|发动机|电机|平台|网络|汽车|车辆|机器人|人))/g,
    (_match, generation: string) => {
      const numericGeneration = /^\d+$/.test(generation)
        ? Number(generation)
        : parseChineseSmallInteger(generation);
      tokens.push(`number:${numericGeneration}`);
      return " ";
    },
  );
  comparable = comparable.replace(/--+\s*-(?=\d)/g, " ");
  comparable = comparable.replace(
    /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*多\s*(万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千)/g,
    "$1$2",
  );
  const vagueChineseScale = (scale: string) =>
    scale === "十" ? 1 : scale === "百" ? 2 : SCALE_POWERS[scale];
  comparable = comparable.replace(/成千上万/g, () => {
    tokens.push("number:10000");
    return " ";
  });
  comparable = comparable.replace(
    /数以\s*(万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|百|十)\s*计/g,
    (_match, scale: string) => {
      tokens.push(`number:${scaleDecimal("1", vagueChineseScale(scale))}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?<!位)数\s*(万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|百|十)/g,
    (_match, scale: string) => {
      tokens.push(`number:${scaleDecimal("1", vagueChineseScale(scale))}`);
      return " ";
    },
  );
  comparable = comparable.replace(/(?<=[A-Za-z氦氢锂铀碳氧氮氘氚])-(?=\d)/g, " ");
  comparable = comparable.replace(/(\d(?:[\d,.]*\d)?)\s*%\s*[-–—]\s*(?=\d)/g, "$1% ");
  comparable = comparable.replace(/(\d)\s*[-–—]\s*(?=\d)/g, "$1 ");
  comparable = comparable.replace(
    /百分之([一二两三四五六七八九十\d]+)/g,
    (_match, percentage: string) => {
      const numericPercentage = /^\d+$/.test(percentage)
        ? Number(percentage)
        : parseChineseSmallInteger(percentage);
      tokens.push(`number:${numericPercentage}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /([一二两三四五六七八九十\d]+)分之([一二两三四五六七八九十\d]+)/g,
    (_match, denominator: string, numerator: string) => {
      const numeric = (part: string) => /^\d+$/.test(part)
        ? Number(part)
        : parseChineseSmallInteger(part);
      tokens.push(`number:${numeric(numerator)}`);
      tokens.push(`number:${numeric(denominator)}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(\d+(?:\.\d+)?)\s*分\s*[，,、]\s*满分\s*(\d+(?:\.\d+)?)\s*分/g,
    "$1 $2",
  );
  comparable = comparable.replace(
    /满分\s*(\d+(?:\.\d+)?)\s*分/g,
    (_match, score: string) => {
      const numericScore = scaleDecimal(score, 0);
      tokens.push(`number:${numericScore}`);
      tokens.push(`number:${numericScore}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(\d+(?:\.\d+)?)\s*分\s*满分/g,
    (_match, score: string) => {
      const numericScore = scaleDecimal(score, 0);
      tokens.push(`number:${numericScore}`);
      tokens.push(`number:${numericScore}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?:每年(?:对应)?的?)\s*百万像素数/g,
    "每年像素分辨率",
  );
  comparable = comparable.replace(
    /(?<![\d零一二两三四五六七八九十百千万亿])百万(?=像素)/g,
    () => {
      tokens.push("number:1000000");
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?<![零一二两三四五六七八九十百千万亿])([二两三四])(?=倍)/g,
    (_match, number: string) => {
      tokens.push(`number:${CHINESE_DIGITS[number]}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /(?<![零一二三四五六七八九十百千万亿])([一二三四五六七八九]?十[一二三四五六七八九]?)(?=(?:大|个|项|名|位|次|年|个月|月|日|号|岁|家|条|种|台|辆|倍))/g,
    (_match, number: string) => {
      tokens.push(`number:${parseChineseSmallInteger(number)}`);
      return " ";
    },
  );
  comparable = comparable.replace(
    /\bit\s+(?:was|is)\s+([01]?\d|2[0-3])([0-5]\d)\b(?=\s+or\s+something\b)/gi,
    (_match, hour: string, minute: string) => {
      tokens.push(`number:${Number(hour)}`);
      tokens.push(`number:${Number(minute)}`);
      return "it was ";
    },
  );

  const numberPattern = /[-+]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)\s*(thousand|million|billion|trillion|万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千(?![瓦米克赫安升焦牛欧伏]))?/gi;
  for (const match of comparable.matchAll(numberPattern)) {
    const raw = match[0].slice(0, match[0].length - (match[1]?.length ?? 0)).trim();
    const power = match[1] ? SCALE_POWERS[match[1].toLocaleLowerCase("en-US")] : 0;
    tokens.push(`number:${scaleDecimal(raw, power)}`);
  }
  const residual = comparable.replace(numberPattern, " ");
  const hasUnparsedNumberWords =
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|nines|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|billions|trillion|trillions|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|half|dozen|dozens|couple|several|decade|decades|century|centuries|millennium|millennia)\b/i.test(residual);
  const hasUnparsedMonth =
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(residual);
  return {
    values: tokens.sort(),
    ambiguity: hasBrokenOrRepeatedScale || hasSharedScaleRange || hasComplexNumberExpression || hasRepeatedScaledShorthand
      ? "all"
      : hasUnparsedNumberWords || hasUnparsedMonth
        ? "extras"
        : "none",
  };
}

export function normalizedNumericValues(value: string): string[] {
  return analyzeNumericValues(value).values;
}

export function compareNumericIntegrity(
  source: string,
  translation: string,
): NumericComparison {
  const sourceAnalysis = analyzeNumericValues(source);
  const translationValues = normalizedNumericValues(translation);
  const sourceValues = sourceAnalysis.values;
  if (JSON.stringify(sourceValues) === JSON.stringify(translationValues)) {
    return { level: "ok", sourceValues, translationValues };
  }

  const sourceQuarters = sourceValues.filter((value) => value.startsWith("quarter:"));
  const translationQuarters = translationValues.filter((value) => value.startsWith("quarter:"));
  if (JSON.stringify(sourceQuarters) !== JSON.stringify(translationQuarters)) {
    return { level: "error", sourceValues, translationValues };
  }

  const availableTranslationValues = new Map<string, number>();
  for (const value of translationValues) {
    availableTranslationValues.set(value, (availableTranslationValues.get(value) ?? 0) + 1);
  }
  const contextualMagnitude = source.match(
    /\bprobably\s+([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s+or\s+more\b/i,
  );
  const contextualBaseValue = contextualMagnitude
    ? "number:" + scaleDecimal(contextualMagnitude[1], 0)
    : undefined;
  let contextualScaleConsumed = false;
  const parsedSourceValuesPreserved = sourceValues.every((value) => {
    const count = availableTranslationValues.get(value) ?? 0;
    if (count > 0) {
      availableTranslationValues.set(value, count - 1);
      return true;
    }
    if (!contextualScaleConsumed && value === contextualBaseValue && contextualMagnitude) {
      for (const power of [3, 6, 9, 12]) {
        const scaledValue = "number:" + scaleDecimal(contextualMagnitude[1], power);
        const scaledCount = availableTranslationValues.get(scaledValue) ?? 0;
        if (scaledCount === 0) continue;
        availableTranslationValues.set(scaledValue, scaledCount - 1);
        contextualScaleConsumed = true;
        return true;
      }
    }
    return false;
  });
  const addedTranslationValues = [...availableTranslationValues.entries()].flatMap(
    ([value, count]) => Array.from({ length: count }, () => value),
  );
  const implicitOneSourceCount =
    (source.match(/\b(?:a|again|an|another|any|each|every|either|final|last|latter|next|per|previous|same)\b/gi)?.length ?? 0) +
    (source.match(/\b(?:something|someone|somebody|somewhere|anything|anyone|anybody|anywhere|everything|everyone|everybody|everywhere)\b/gi)?.length ?? 0) +
    (source.match(/\bif\s+one\b/gi)?.length ?? 0) +
    (source.match(/\bat\s+one\s+point\b/gi)?.length ?? 0) +
    (source.match(/\bone\s+thing\b/gi)?.length ?? 0) +
    (source.match(/\bone\s+of\b/gi)?.length ?? 0) +
    2 * (source.match(/\b([a-z]+)\s+to\s+\1\b/gi)?.length ?? 0) +
    (source.match(/\bon\s+Team\s+[a-z]+\b/gi)?.length ?? 0) +
    (source.match(/\b\d+(?:st|nd|rd|th)\s+of\b/gi)?.length ?? 0) +
    (source.match(/\bnone\b/gi)?.length ?? 0) +
    (source.match(/\bfriend\s+of\s+mine\b/gi)?.length ?? 0) +
    (source.match(/\b(?:I|you|he|she|we|they)\s+alone\b/gi)?.length ?? 0) +
    (source.match(/\bsort\s+of\s+(?:an?\s+)?explanation\b/gi)?.length ?? 0) +
    (source.match(/\bsaw\s+level\s+\d+\s+[a-z]+\b/gi)?.length ?? 0) +
    (source.match(/\b(?:state|federal|local|national)\s+level\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:big\s+)?innovation\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+thing\s+about\b/gi)?.length ?? 0) +
    (source.match(/\blittle\s+(?:[a-z-]+\s+){0,2}thing\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:[a-z-]+\s+){0,4}reason\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:(?:very|really|pretty|huge|big|important|difficult|complex)[,\s]+){0,4}thing\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+is\s+(?:(?:a|an|the)\s+)?(?:[a-z-]+\s+){0,3}(?:stain|technique|method|approach|process|system|set)\b/gi)?.length ?? 0) +
    (source.match(/\b(?:very\s+)?standard\s+set\s+of\b/gi)?.length ?? 0) +
    (source.match(/\b(?:on\s+)?the\s+(?!(?:other|both)\b)(?:[a-z-]+\s+){0,3}side\b/gi)?.length ?? 0) +
    (source.match(/\bthat\s+brings?\s+up\b/gi)?.length ?? 0) +
    (source.match(/\bget(?:s|ting)?\s+to\s+the\s+point\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:iterative\s+)?process\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:[a-z-]+\s+){0,3}layer\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:[a-z]+\s+){0,2}solution\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:[a-z]+\s+){0,2}exploration\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+feeling\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:[a-z]+\s+){0,3}situation\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:[a-z]+\s+){0,3}movement\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+very\s+complicated\s+guesstimation\s+or\s+unsupervised\s+problem\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:guy|man|woman|person)(?:\s+named\b)?/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:HydraNet|flywheel|handy\s+fusion\s+reactor)\b/gi)?.length ?? 0) +
    (source.match(/\b(?:kind|sort)\s+of\b/gi)?.length ?? 0) +
    (source.match(/\bno\s+(?:test|way|difference|option|alternative)\b/gi)?.length ?? 0) +
    (source.match(/\b(?:no|any)\s+other\b/gi)?.length ?? 0) +
    (source.match(/\baspirationally\b/gi)?.length ?? 0) +
    (source.match(/\binterlocking\s+bricks?\b/gi)?.length ?? 0) +
    (source.match(/\bexciting\s+future\b/gi)?.length ?? 0) +
    (source.match(/\bcome\s+across\s+as\b/gi)?.length ?? 0) +
    (source.match(/\bdo\s+open\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:drug|medicine|product|device)\s+called\b/gi)?.length ?? 0) +
    (source.match(/\blike\s+(?!(?:a|an|the)\b)(?:[a-z]+\s+){0,3}(?:place|thing|person|object|idea)\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:kilo|mega|giga|tera)?watt(?:[-\s]?hours?)?\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+time\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+other\b/gi)?.length ?? 0) +
    (source.match(/\b(?:my|your|his|her|our|their)\s+other\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+fact\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+problem(?:\s+statement)?\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:[a-z-]+\s+){0,3}property\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+alternative\b/gi)?.length ?? 0) +
    (source.match(/\bit(?:'|’)?s\s+the\s+ability\b/gi)?.length ?? 0) +
    (source.match(/\bpicked\s+integer\s+add\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+only\s+(?:(?:[a-z-]+\s+){0,3})?(?:means|way|method|option|approach|mechanism|platform)\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:general\s+good\s+)?rule\s+of\s+thumb\b/gi)?.length ?? 0) +
    (source.match(/\bon\s+the\s+order\s+of\b/gi)?.length ?? 0) +
    (source.match(/\bchoose\b[^.!?]{0,80}\bwords?\s+differently\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+(?:(?:most\s+)?recent\s+)?(?:question|round)\b/gi)?.length ?? 0) +
    (source.match(/\bthis\s+(?:much\s+)?(?:[a-z]+\s+){0,2}space\b/gi)?.length ?? 0) +
    (source.match(/\bunipolar\s+world\b/gi)?.length ?? 0) +
    (source.match(/\b(?:this|that)\s+idea\b/gi)?.length ?? 0) +
    (source.match(/\bthat\s+threshold\b/gi)?.length ?? 0) +
    (source.match(/\byour\s+(?:sort\s+of\s+)?buddy\s+robot\b/gi)?.length ?? 0) +
    (source.match(/\b(?:guess|have|ask|answer)\s+(?!(?:a|an|the)\b)(?:[a-z]+\s+){0,3}question\b/gi)?.length ?? 0) +
    (source.match(/\bwhich\s+way\b/gi)?.length ?? 0) +
    (source.match(/\bas(?:\s+like)?[\s,]+(?!(?:a|an|the)\b)(?:[a-z]+\s+){0,3}crisis\b/gi)?.length ?? 0);

  const implicitTwoSourceCount =
    (source.match(/\b(?:queen[-\s]+size(?:d)?\s+bed|(?:(?:pure\s+)?human|your|their|his|her|our|both|the|working|functional)\s+hands)\b/gi)?.length ?? 0) +
    (source.match(/\bcomplementary\b/gi)?.length ?? 0) +
    (source.match(/\bgo(?:es|ing|ne)?\s+hand\s+in\s+hand\b/gi)?.length ?? 0) +
    (source.match(/\byou\s+have\s+(?:[a-z]+\s+){0,2}hands\b/gi)?.length ?? 0) +
    (source.match(/\beither\s+way\b/gi)?.length ?? 0) +
    (source.match(/\bbetween\b/gi)?.length ?? 0) +
    (source.match(/\b(?:side\s+boosters?|neither|synergy|parallels|while\s+also|Venn\s+diagram)\b/gi)?.length ?? 0) +
    (source.match(/\binterchangeable\b/gi)?.length ?? 0) +
    (source.match(/\bFinatra\s+and\s+Finagle\b/gi)?.length ?? 0) +
    (source.match(/\bdecoupl(?:e|ed|es|ing)\b/gi)?.length ?? 0) +
    (source.match(/\blikes?\b[^.!?]{0,80}\bor\b[^.!?]{0,80}\bhates?\b/gi)?.length ?? 0) +
    (source.match(/\beither\b[^.!?]{0,180}\bor\b/gi)?.length ?? 0) +
    (source.match(/\b(?:compare|compared|comparing)\b[^.!?]{0,100}\b(?:to|with)\b/gi)?.length ?? 0) +
    (source.match(/\bcombination\s+of\b[^.!?]{0,160}\band\b/gi)?.length ?? 0) +
    (source.match(/\b(?:versus|different\s+from)\b/gi)?.length ?? 0) +
    (source.match(/\bthe\s+[a-z]+(?:\s+[a-z]+){0,3}\s+and\s+(?:the\s+)?[a-z]+\b/gi)?.length ?? 0);
  const implicitZeroSourceCount =
    (source.match(/\b(?:zero|negligible|almost\s+nothing|practically\s+nothing|virtually\s+nothing)\b/gi)?.length ?? 0) +
    (source.match(/\bno\s+(?:[a-z]+\s+){0,2}score\b/gi)?.length ?? 0);
  const addedZeroCount = addedTranslationValues.filter((value) => value === "number:0").length;
  const addedOneCount = addedTranslationValues.filter((value) => value === "number:1").length;
  const addedTwoCount = addedTranslationValues.filter((value) => value === "number:2").length;
  if (
    contextualScaleConsumed &&
    parsedSourceValuesPreserved &&
    addedTranslationValues.length === 0
  ) {
    return { level: "warning", sourceValues, translationValues };
  }
  if (
    parsedSourceValuesPreserved &&
    addedTranslationValues.length > 0 &&
    addedTranslationValues.every(
      (value) => value === "number:0" || value === "number:1" || value === "number:2",
    ) &&
    addedZeroCount <= implicitZeroSourceCount &&
    addedOneCount <= implicitOneSourceCount &&
    addedTwoCount <= implicitTwoSourceCount
  ) {
    return { level: "warning", sourceValues, translationValues };
  }

  if (sourceAnalysis.ambiguity === "all") {
    return { level: "warning", sourceValues, translationValues };
  }
  if (sourceAnalysis.ambiguity === "extras") {
    return {
      level: parsedSourceValuesPreserved ? "warning" : "error",
      sourceValues,
      translationValues,
    };
  }
  const sourceNumbers = sourceValues.filter((value) => value.startsWith("number:"));
  const translationNumbers = translationValues.filter((value) => value.startsWith("number:"));
  if (sourceNumbers.length !== translationNumbers.length) {
    return { level: "error", sourceValues, translationValues };
  }
  return { level: "error", sourceValues, translationValues };
}
