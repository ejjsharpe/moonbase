# Bundled fonts

The shared reset registers Manrope for interface text and SpaceMono Nerd Font Mono for code. The shared `type.sans` / `type.mono` tokens retain platform fallbacks. The user selected this pairing after comparing interface and editor font specimens.

Fonts are local WOFF2 resources, served and packaged through the existing CSS asset pipeline. No remote font request or system installation is required. Manrope retains its variable weight axis, 200–800. Space Mono includes regular, italic, bold and bold italic faces; all 11,183 mapped characters in each upstream face, including Nerd glyphs, remain available. UI icons continue to use the existing Tabler components.

## Sources

- Manrope: [Google Fonts commit `b31870aff700ab7a1d74fa0c6887d95beb9e0037`](https://github.com/google/fonts/tree/b31870aff700ab7a1d74fa0c6887d95beb9e0037/ofl/manrope), `Manrope[wght].ttf` and `OFL.txt`.
- Space Mono: [Nerd Fonts v3.4.0, commit `fa7b859994228a9c8759f99c55a8d31ee92a1b5e`](https://github.com/ryanoasis/nerd-fonts/tree/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/patched-fonts/SpaceMono). Each style directory supplies `SpaceMonoNerdFontMono-<Style>.ttf`; `Regular/OFL.txt` supplies the original Space Mono license. Nerd Fonts' root `LICENSE` is retained as well.

The TTF files were converted with FontTools' `TTFont`: set `font.flavor = 'woff2'`, then save. No subsetting, naming, glyph or metric edits were made. Conversion checked that the output and input character maps have the same code points and that the variable weight range remains intact. The fonts retain their upstream metadata. Original copyright and license text is collected in `fonts/NOTICES.txt`, exported as `@moonbase/ui/font-notices`; desktop appends it to `dist/dependency-notices.txt`.

Monaco measures text before a web font may have finished loading. Workbench refreshes Monaco's cached widths after `document.fonts.ready`, provided the view is still mounted. Its browser regression delays the regular font, then checks that the cursor meets the end of the rendered text after loading.
