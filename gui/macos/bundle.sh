#!/bin/sh
# Assembles Tabcat.app from the SwiftPM build.
#
# A bundle is required, not cosmetic: LSUIElement lives in Info.plist, and without
# it the overlay gets a Dock icon and switches the active application when it
# appears. A bare `swift run` sets the activation policy in code, which is enough
# for development but not for a real launch.
#
# Signing is irrelevant for a locally built binary — Gatekeeper only checks what a
# browser marked with com.apple.quarantine. It is still done here with a stable
# identity, so that if anything TCC-gated is ever added, the permission survives a
# rebuild instead of having to be granted again.
set -eu

cd "$(dirname "$0")"

CONFIG=${CONFIG:-release}
APP="build/Tabcat.app"
IDENTITY=${TABCAT_SIGN_IDENTITY:-}

swift build -c "$CONFIG"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp ".build/$CONFIG/TabcatGUI" "$APP/Contents/MacOS/TabcatGUI"
cp Info.plist "$APP/Contents/Info.plist"

# SwiftPM puts processed resources in a bundle of their own next to the binary, and
# `Bundle.module` looks for it beside the executable or in the app's Resources. Without
# this the wordmark silently goes missing in the bundled app while it is there under
# `swift run` — the kind of difference between the two builds that took a whole
# debugging session the last time (`ToolPath`). Every generated bundle is carried, not
# just ours: SwiftTerm ships its Metal shaders the same way.
mkdir -p "$APP/Contents/Resources"
for resources in ".build/$CONFIG/"*.bundle; do
	[ -e "$resources" ] || continue
	cp -R "$resources" "$APP/Contents/Resources/"
done

if [ -n "$IDENTITY" ]; then
	codesign --force --sign "$IDENTITY" "$APP"
else
	# Ad-hoc. arm64 needs some signature; the linker applies one, this makes it
	# explicit and keeps the bundle consistent after the copy above.
	codesign --force --sign - "$APP"
fi

echo "built $APP"
echo "run:  killall TabcatGUI 2>/dev/null; open $APP"
echo "logs: log stream --predicate 'subsystem == \"nl.d3vpunk.tabcat.gui\"'"
