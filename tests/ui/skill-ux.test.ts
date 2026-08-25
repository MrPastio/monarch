import { describe, expect, it } from 'vitest';
import {
  filterSkillPickerSkills,
  parseSkillInvocation,
  skillUserFacingDescription,
  skillUserFacingName,
} from '../../src/ui/public/modules/skill-ux.js';

describe('skill UX helpers', () => {
  const skills = [
    {
      name: 'system-docs',
      displayName: 'System Docs',
      description: 'Documentation workflow',
      scope: 'system',
      compatible: true,
    },
    {
      name: 'monarch-file-guardian',
      displayName: 'Monarch File Guardian',
      description: 'File workflow',
      scope: 'project',
      compatible: true,
    },
    {
      name: 'release-helper',
      displayName: 'Release Helper',
      description: 'Release workflow',
      scope: 'user',
      compatible: true,
    },
  ];

  it('shows personal skills first and searches the full compatible catalog', () => {
    expect(filterSkillPickerSkills(skills).map((skill) => skill.name)).toEqual([
      'monarch-file-guardian',
      'release-helper',
    ]);
    expect(filterSkillPickerSkills(skills, 'docs').map((skill) => skill.name)).toEqual(['system-docs']);
    expect(filterSkillPickerSkills(skills, 'файлы').map((skill) => skill.name)).toEqual(['monarch-file-guardian']);
  });

  it('keeps the technical marker out of the visible request', () => {
    expect(parseSkillInvocation('$monarch-file-guardian Наведи порядок')).toEqual({
      skillName: 'monarch-file-guardian',
      visibleContent: 'Наведи порядок',
    });
    expect(parseSkillInvocation('Обычный запрос')).toEqual({
      skillName: '',
      visibleContent: 'Обычный запрос',
    });
  });

  it('uses concise local language for core Monarch skills', () => {
    expect(skillUserFacingName(skills[1])).toBe('Работа с файлами');
    expect(skillUserFacingDescription(skills[1])).toContain('проверить результат');
    expect(skillUserFacingName({ name: 'release-helper' })).toBe('Release helper');
  });
});
