# Language Server and Client for XQuery/eXistdb

This repository contains both, a language server and a Visual Studio Code extension for developing XQuery code targeted at eXistdb. The language server currently supports the following capabilities for XQuery:

* linting: shows errors reported by eXistdb and warnings produced by XQLint
* autocomplete for all functions known in the XQuery context of the current file, including imported modules
* document symbols (functions only) for outline view
* hover: incomplete, just shows local function signatures

The client extension additionally includes XQuery syntax highlighting copied from https://github.com/DotJoshJohnson/vscode-xml.

## Prerequisites

The server side support package for the Atom editor - `atom-editor` needs to be installed on the server.

## Run

* clone the repository and open the directory in Visual Studio Code
* run `npm install`
* switch to the debug panel in the sidebar and choose *Launch Client* from the run configurations

## Packaging

Install `vsce` once by running

```
npm install -g vsce
```

then package the extension into a `.vsix` file with

```
vsce package
```

The package is rather large at the moment. It should be preprocessed with webpack when released (not done yet).