import React from 'react';
import { Alert, Modal, Spin } from 'antd';
import { useQuery } from 'react-query';
import { OrganizationForm } from '@opensrp/fhir-team-management';
import type { OrganizationFormFields } from '@opensrp/fhir-team-management';
import {
  BodyLayout,
  getObjLike,
  getResourcesFromBundle,
  IdentifierUseCodes,
  loadAllResources,
  parseFhirHumanName,
} from '@opensrp/react-utils';
import type { IPractitioner } from '@smile-cdr/fhirts/dist/FHIR-R4/interfaces/IPractitioner';
import type { IPractitionerRole } from '@smile-cdr/fhirts/dist/FHIR-R4/interfaces/IPractitionerRole';
import { readDrafts } from '../Drafts/useDraftStore';
import { StepKey } from '../../types';
import type { UserFormValues } from '../../types';

type OrgDraft = OrganizationFormFields & { draftId?: string };

interface OrganizationStepAdapterProps {
  onSubmit: (values: OrganizationFormFields) => boolean | void;
  initialValues?: OrganizationFormFields;
  fhirBaseURL: string;
  currentDrafts?: unknown[]; // this step's drafts, passed by StepPanel so the list is never one step behind
  moveMembersFromOtherDrafts?: (members: string[]) => void; // passed by StepPanel
}

const confirmMove = (lines: string[]) =>
  new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: 'Move practitioners to this organization?',
      content: (
        <div>
          <p>A practitioner can belong to only one organization.</p>
          <ul>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ),
      okText: 'Move',
      cancelText: 'Cancel',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });

export const OrganizationStepAdapter: React.FC<OrganizationStepAdapterProps> = (props) => {
  const practitioners = useQuery(
    ['Practitioner'],
    () => loadAllResources(props.fhirBaseURL, 'Practitioner', { active: true }),
    {
      select: (res) => getResourcesFromBundle(res) as IPractitioner[],
      enabled: !!props.fhirBaseURL,
    }
  );

  // roles that already have an organization show where each practitioner is now
  const roles = useQuery(
    ['wizard-practitioner-roles', props.fhirBaseURL],
    () => loadAllResources(props.fhirBaseURL, 'PractitionerRole', { active: true }),
    {
      select: (res) => getResourcesFromBundle<IPractitionerRole>(res),
      enabled: !!props.fhirBaseURL,
      refetchOnWindowFocus: false,
    }
  );

  if (!props.fhirBaseURL) {
    return <Alert type="error" message="The wizard did not receive a FHIR base URL." />;
  }

  if (practitioners.isLoading || roles.isLoading) {
    return <Spin size="large" className="custom-spinner" />;
  }

  if (practitioners.isError || roles.isError) {
    const error = (practitioners.error ?? roles.error) as Error | null;
    return <Alert type="error" message="Could not load practitioners" description={error?.message} />;
  }

  const draftPractitionerOptions = readDrafts<UserFormValues & { draftId: string }>(
    StepKey.USERS
  ).map((u) => ({
    label: `${[u.firstName, u.lastName].filter(Boolean).join(' ') || u.username} (draft)`,
    value: `draft:${u.draftId}`,
  }));

  // names shown in the dialog
  const practitionerNames = new Map<string, string>();
  (practitioners.data ?? []).forEach((p) => {
    const name = parseFhirHumanName(getObjLike(p.name, 'use', IdentifierUseCodes.OFFICIAL)[0]);
    practitionerNames.set(`Practitioner/${p.id}`, name || `Practitioner/${p.id}`);
  });
  draftPractitionerOptions.forEach((o) => practitionerNames.set(o.value, o.label));

  // where each practitioner is now: an organization on the server, or another draft organization
  const holder = new Map<string, { name: string; inDraft: boolean }>();
  (roles.data ?? []).forEach((role) => {
    const practitionerRef = role.practitioner?.reference;
    if (practitionerRef && role.organization?.reference) {
      holder.set(practitionerRef, {
        name: role.organization.display ?? role.organization.reference,
        inDraft: false,
      });
    }
  });
  const ownDraftId = (props.initialValues as OrgDraft | undefined)?.draftId;
  const orgDrafts =
    (props.currentDrafts as OrgDraft[] | undefined) ?? readDrafts<OrgDraft>(StepKey.ORGANIZATION);
  orgDrafts
    .filter((org) => org.draftId !== ownDraftId) // the draft being edited keeps its own practitioners
    .forEach((org) => {
      (org.members ?? []).forEach((member) => {
        holder.set(member, { name: org.name ?? 'another organization', inDraft: true });
      });
    });

  const handleDraftSubmit = async (values: OrganizationFormFields) => {
    const taken = (values.members ?? []).filter((member) => holder.has(member));
    if (taken.length) {
      const lines = taken.map((member) => {
        const where = holder.get(member);
        return `${practitionerNames.get(member) ?? member} is in ${where?.name}${
          where?.inDraft ? ' (draft)' : ''
        }.`;
      });
      if (!(await confirmMove(lines))) return false; // the form keeps what was typed
    }
    const accepted = props.onSubmit(values);
    if (accepted !== false) {
      // draft organizations that held them lose them, so a practitioner stays in one organization
      props.moveMembersFromOtherDrafts?.(taken.filter((member) => holder.get(member)?.inDraft));
    }
    return accepted;
  };

  const headerProps = {
    pageHeaderProps: { title: 'Create organization', onBack: undefined },
  };

  return (
    <BodyLayout headerProps={headerProps}>
      <div className="bg-white p-5">
        <OrganizationForm
          fhirBaseUrl={props.fhirBaseURL}
          initialValues={props.initialValues ?? {}}
          disabled={[]}
          practitioners={practitioners.data ?? []}
          existingPractitionerRoles={[]}
          allPractitionerRoles={[]}
          onDraftSubmit={handleDraftSubmit}
          draftPractitionerOptions={draftPractitionerOptions}
        />
      </div>
    </BodyLayout>
  );
};