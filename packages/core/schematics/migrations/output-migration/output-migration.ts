/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';
import {
  confirmAsSerializable,
  ProgramInfo,
  ProjectRelativePath,
  Replacement,
  Serializable,
  TsurgeFunnelMigration,
  projectRelativePath,
} from '../../utils/tsurge';

import {DtsMetadataReader} from '../../../../compiler-cli/src/ngtsc/metadata';
import {TypeScriptReflectionHost} from '../../../../compiler-cli/src/ngtsc/reflection';
import {
  isOutputDeclaration,
  OutputID,
  getUniqueIdForProperty,
  getTargetPropertyDeclaration,
  extractSourceOutputDefinition,
  isProblematicEventEmitterUsage,
} from './output_helpers';
import {calculateImportReplacements, calculateDeclarationReplacements} from './output-replacements';

interface OutputMigrationData {
  path: ProjectRelativePath;
  replacements: Replacement[];
}

interface CompilationUnitData {
  outputFields: Record<OutputID, OutputMigrationData>;
  problematicUsages: Record<OutputID, true>;
  importReplacements: Record<
    ProjectRelativePath,
    {add: Replacement[]; addAndRemove: Replacement[]}
  >;
}

export class OutputMigration extends TsurgeFunnelMigration<
  CompilationUnitData,
  CompilationUnitData
> {
  override async analyze({
    sourceFiles,
    program,
    projectDirAbsPath,
  }: ProgramInfo): Promise<Serializable<CompilationUnitData>> {
    const outputFields: Record<OutputID, OutputMigrationData> = {};
    const problematicUsages: Record<OutputID, true> = {};

    const filesWithOutputDeclarations = new Set<ProjectRelativePath>();

    const checker = program.getTypeChecker();
    const reflector = new TypeScriptReflectionHost(checker);
    const dtsReader = new DtsMetadataReader(checker, reflector);

    const outputMigrationVisitor = (node: ts.Node) => {
      // detect output declarations
      if (ts.isPropertyDeclaration(node)) {
        const outputDef = extractSourceOutputDefinition(node, reflector, projectDirAbsPath);
        if (outputDef !== null) {
          const relativePath = projectRelativePath(node.getSourceFile(), projectDirAbsPath);

          filesWithOutputDeclarations.add(relativePath);
          outputFields[outputDef.id] = {
            path: relativePath,
            replacements: calculateDeclarationReplacements(
              projectDirAbsPath,
              node,
              outputDef.aliasParam,
            ),
          };
        }
      }

      // detect unsafe access of the output property
      if (isProblematicEventEmitterUsage(node)) {
        const targetSymbol = checker.getSymbolAtLocation(node.expression);
        if (targetSymbol !== undefined) {
          const propertyDeclaration = getTargetPropertyDeclaration(targetSymbol);
          if (
            propertyDeclaration !== null &&
            isOutputDeclaration(propertyDeclaration, reflector, dtsReader)
          ) {
            const id = getUniqueIdForProperty(projectDirAbsPath, propertyDeclaration);
            problematicUsages[id] = true;
          }
        }
      }

      ts.forEachChild(node, outputMigrationVisitor);
    };

    // calculate output migration replacements
    for (const sf of sourceFiles) {
      ts.forEachChild(sf, outputMigrationVisitor);
    }

    // calculate import replacements but do so only for files that have output declarations
    const importReplacements = calculateImportReplacements(
      projectDirAbsPath,
      sourceFiles.filter((sf) =>
        filesWithOutputDeclarations.has(projectRelativePath(sf, projectDirAbsPath)),
      ),
    );

    return confirmAsSerializable({
      outputFields,
      importReplacements,
      problematicUsages,
    });
  }

  override async merge(units: CompilationUnitData[]): Promise<Serializable<CompilationUnitData>> {
    const outputFields: Record<OutputID, OutputMigrationData> = {};
    const importReplacements: Record<
      ProjectRelativePath,
      {add: Replacement[]; addAndRemove: Replacement[]}
    > = {};
    const problematicUsages: Record<OutputID, true> = {};

    for (const unit of units) {
      for (const declIdStr of Object.keys(unit.outputFields)) {
        const declId = declIdStr as OutputID;
        // THINK: detect clash? Should we have an utility to merge data based on unique IDs?
        outputFields[declId] = unit.outputFields[declId];
      }

      for (const pathStr of Object.keys(unit.importReplacements)) {
        const path = pathStr as ProjectRelativePath;
        importReplacements[path] = unit.importReplacements[path];
      }

      for (const declIdStr of Object.keys(unit.problematicUsages)) {
        const declId = declIdStr as OutputID;
        problematicUsages[declId] = unit.problematicUsages[declId];
      }
    }

    return confirmAsSerializable({
      outputFields,
      importReplacements,
      problematicUsages,
    });
  }

  override async migrate(globalData: CompilationUnitData): Promise<Replacement[]> {
    const migratedFiles = new Set<ProjectRelativePath>();
    const problematicFiles = new Set<ProjectRelativePath>();

    const replacements: Replacement[] = [];
    for (const declIdStr of Object.keys(globalData.outputFields)) {
      const declId = declIdStr as OutputID;
      const outputField = globalData.outputFields[declId];

      if (!globalData.problematicUsages[declId]) {
        replacements.push(...outputField.replacements);
        migratedFiles.add(outputField.path);
      } else {
        problematicFiles.add(outputField.path);
      }
    }

    for (const pathStr of Object.keys(globalData.importReplacements)) {
      const path = pathStr as ProjectRelativePath;
      if (migratedFiles.has(path)) {
        const importReplacements = globalData.importReplacements[path];
        if (problematicFiles.has(path)) {
          replacements.push(...importReplacements.add);
        } else {
          replacements.push(...importReplacements.addAndRemove);
        }
      }
    }

    return replacements;
  }
}
