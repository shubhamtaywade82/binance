/**
 * One-shot codemod: function declarations → const + arrow (excludes class bodies, overloads, generators).
 * Run: npx ts-node scripts/func-to-arrow-codemod.ts
 */
import { FunctionDeclaration, Project, SyntaxKind } from 'ts-morph';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

const project = new Project({
  tsConfigFilePath: path.join(root, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    allowJs: true,
    target: 99,
    module: 99,
    moduleResolution: 99,
    strict: true,
    esModuleInterop: true,
  },
});

project.addSourceFilesAtPaths([
  path.join(root, 'src/**/*.ts'),
  path.join(root, 'tests/**/*.ts'),
  path.join(root, 'scripts/**/*.ts'),
  path.join(root, 'ui/**/*.js'),
]);

const shouldSkip = (fd: FunctionDeclaration): boolean => {
  if (!fd.getNameNode()) return true;
  if (!fd.getBody()) return true;
  if (fd.isGenerator()) return true;
  if (fd.hasModifier(SyntaxKind.DeclareKeyword)) return true;
  if (fd.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)) return true;
  const p = fd.getParent();
  if (p?.getKind() === SyntaxKind.InterfaceDeclaration) return true;
  return false;
};

const buildReplacement = (fd: FunctionDeclaration): string => {
  const name = fd.getName();
  const tps = fd.getTypeParameters();
  const typeParamsStr = tps.length > 0 ? `<${tps.map((t) => t.getText()).join(', ')}>` : '';
  const params = fd.getParameters().map((p) => p.getText()).join(', ');
  const retNode = fd.getReturnTypeNode();
  const ret = retNode ? `: ${retNode.getText()}` : '';
  const body = fd.getBody()!.getText();
  const asyncKw = fd.isAsync() ? 'async ' : '';
  const rhs = `${asyncKw}${typeParamsStr}(${params})${ret} => ${body}`;

  const exported = fd.isExported();
  const defaultExp = fd.isDefaultExport();

  if (defaultExp && exported) {
    return `const ${name} = ${rhs};\nexport default ${name}`;
  }
  if (exported) {
    return `export const ${name} = ${rhs}`;
  }
  return `const ${name} = ${rhs}`;
};

const files = project
  .getSourceFiles()
  .filter((sf) => !sf.getFilePath().endsWith('func-to-arrow-codemod.ts'));

for (const sf of files) {
  const decls = sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).filter((fd) => !shouldSkip(fd));
  decls.sort((a, b) => b.getStart() - a.getStart());

  for (const fd of decls) {
    try {
      const replacement = buildReplacement(fd);
      fd.replaceWithText(replacement);
    } catch (e) {
      console.warn('[codemod] skip', sf.getFilePath(), fd.getName(), (e as Error).message);
    }
  }
}

void project.save().then(() => {
  console.log('[codemod] done');
});
