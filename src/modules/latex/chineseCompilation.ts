import { maskLatexExamples } from "./source";

// Load fontspec with the option expected by older Type 1 font packages before
// ctex/xeCJK can load it. Keep the template's existing math fonts.
const FONT_OPTIONS = String.raw`% HJFY Chinese compilation compatibility
\PassOptionsToPackage{no-math}{fontspec}
`;

// XeTeX's microtype backend cannot inspect Type 1 glyphs. soul's syllable
// reconstruction also fails on translated CJK text; xeCJK's ulem integration
// supplies breakable highlighting while retaining soul's selected color.
const XETEX_SUPPORT = String.raw`
\ifdefined\XeTeXversion
  \makeatletter
  \@ifpackageloaded{microtype}{%
    \microtypesetup{protrusion=false,expansion=false,tracking=false}%
  }{}
  \@ifpackageloaded{xeCJK}{%
    \@ifpackageloaded{enumitem}{%
      % xeCJK's label grouping breaks enumitem's unboxed multiline parser.
      % Keep multiline alignment and width, but use its supported boxed path.
      \AddToHook{cmd/enit@style@multiline/after}{\enit@boxdesctrue}%
    }{}%
    \@ifpackageloaded{soul}{%
      \RequirePackage{xeCJKfntef}%
      \DeclareRobustCommand{\hl}[1]{%
        \CJKunderanyline{0.5ex}{\SOUL@hlcolor{\rule{2pt}{2.5ex}}}{#1}}%
    }{}%
  }{}
  \makeatother
\fi
\makeatletter
\@ifpackageloaded{wrapstuff}{%
  % Translated paragraphs may end before the wrapping area is exhausted.
  % Finish that area before a separate float measures its caption in a box.
  \AddToHook{env/figure/before}{\wrapstuffclear}%
  \AddToHook{env/figure*/before}{\wrapstuffclear}%
  \AddToHook{env/table/before}{\wrapstuffclear}%
  \AddToHook{env/table*/before}{\wrapstuffclear}%
}{}
\makeatother
`;

/** Prepare a compilation copy; never change translation units or cache keys. */
export function prepareChineseCompilation(source: string): string {
  if (source.includes(FONT_OPTIONS)) return source;
  const clean = maskLatexExamples(source);
  const documentClass = /\\documentclass\b/.exec(clean);
  const document = /\\begin\s*\{document\}/.exec(clean);
  if (!documentClass || !document || document.index < documentClass.index)
    return source;
  return (
    source.slice(0, documentClass.index) +
    FONT_OPTIONS +
    source.slice(documentClass.index, document.index) +
    XETEX_SUPPORT +
    source.slice(document.index)
  );
}
