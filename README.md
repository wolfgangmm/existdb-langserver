# Language Server and Client for XQuery/eXistdb

[![Build Status](https://travis-ci.com/wolfgangmm/existdb-langserver.svg?branch=master)](https://travis-ci.com/wolfgangmm/existdb-langserver)

A language server and Visual Studio Code extension for developing XQuery code targeted at eXistdb. The language server currently supports the following capabilities for XQuery:

* linting: shows errors reported by eXistdb and warnings produced by XQLint
* autocomplete for all functions known in the XQuery context of the current file, including imported modules
* document symbols (functions only) for outline view
* hover: shows signatures and description for local, imported and system-wide functions
* goto definition: navigate to definition of function in local or imported module (as long as it is in the same workspace)

The client extension additionally includes XQuery syntax highlighting copied from https://github.com/DotJoshJohnson/vscode-xml.

## Syncing Directories to the Server

The extension includes a task provider, which automatically registers a sync task for a workspace if a `.existdb.json` configuration is found and defines sync settings (the [readme for the Atom plugin](https://github.com/eXist-db/atom-existdb), which uses the same config format). The task must be started manually though:

1. select `Terminal` / `Run Task` from the Visual Studio Code menu
2. find a task named `existdb-sync-name-of-your-workspace` and select it

## Executing XQueries

An open XQuery file can be sent to the server for evaluation, using either

* the command `existdb.execute` from the command palette
* pressing the keyboard shortcut `ctrl-alt-enter´ (`command-option-enter` on a Mac)
* selecting **Execute current XQuery on the server** from the editor title toolbar

The result returned by eXist is displayed in a new column besides the currently open editor. If the XQuery defines serialization to HTML, the results will be shown in a web view. In all other cases, the source code of the result is displayed.

## Configuration

The [server side support package](https://github.com/eXist-db/atom-editor-support) for the Atom editor - `atom-editor` needs to be deployed on the server. The extension  will try to detect if the package is already installed - if not it will ask if it should install it automatically.

The parameters required for the communication with the server can either be configured via the extension settings, or via a `.existdb.json` file in the root directory of a workspace. The configuration syntax of this file is the same as for the [Atom plugin](https://github.com/eXist-db/atom-existdb).

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
