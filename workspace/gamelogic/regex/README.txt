One regex object per .json file; the filename is yours, the IDENTITY is script_name
(install, upgrade and uninstall all find a regex by that name, so two files may never
share one). HideFarFloor.json is a SAMPLE - rename or delete it. It blanks the DISPLAY
of anything at depth 10 or deeper, leaving the prompt untouched: find_regex /.*/s with
the s flag so . spans newlines, an empty replace_string, destination.display true and
prompt false. A regex whose destination.prompt is true rewrites what the MODEL reads,
and must declare prompt_rewrite_intended: true to say it meant to.
